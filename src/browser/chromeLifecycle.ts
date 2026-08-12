import { rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { spawn } from "node:child_process";
import CDP from "chrome-remote-interface";
import { launch, Launcher, type LaunchedChrome } from "chrome-launcher";
import type { BrowserLogger, ResolvedBrowserConfig, ChromeClient } from "./types.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  attachCoordinatorTarget,
  clearCoordinatorResourceObservation,
  finalizeCoordinatorTarget,
  recordCoordinatorResourceObservation,
  reserveCoordinatorTarget,
} from "./coordinatorRuntime.js";
import type { CoordinatorRuntimeOptions, CoordinatorTargetLease } from "./coordinatorRuntime.js";
import type { BrowserCoordinatorTargetRole } from "./coordinatorStore.js";
import { cleanupStaleProfileState } from "./profileState.js";
import { delay } from "./utils.js";
import { resolveWslChromeLaunchRoute } from "./wslHost.js";
import {
  closeRemoteChromePageTarget,
  DEFAULT_REMOTE_CHROME_MAX_TABS,
  forgetRemoteChromeTarget,
  pruneRemoteChromeTargets,
  recordRemoteChromeTarget,
} from "./remoteChromeTabs.js";
import {
  startOwnedChromeResourceWatchdog,
  terminateVerifiedOwnedChromeTree,
  type BrowserResourceWatchdog,
} from "./resourceWatchdog.js";
export interface MonitoredLaunchedChrome extends LaunchedChrome {
  host?: string;
  resourceExhaustion?: Promise<never>;
  stopResourceWatchdog?: () => void;
}

export async function launchChrome(
  config: ResolvedBrowserConfig,
  userDataDir: string,
  logger: BrowserLogger,
): Promise<MonitoredLaunchedChrome> {
  const { connectHost, debugBindAddress, usePatchedLauncher } = resolveWslChromeLaunchRoute();
  const debugPort = config.debugPort ?? parseDebugPortEnv();
  const chromeFlags = buildChromeFlags(
    config.headless ?? false,
    debugBindAddress,
    config.hideWindow ?? false,
  );
  // copy-profile reuses a copied signed-in profile whose cookies are
  // Keychain-encrypted, so it must launch with the real Keychain (not mocked):
  // strip the keychain-mocking flags from both chrome-launcher's defaults and
  // Oracle's set, and ignore the defaults so they aren't re-added.
  const usingCopiedProfile = Boolean(config.copyProfileSource);
  if (usingCopiedProfile && config.chromeProfile) {
    chromeFlags.push(`--profile-directory=${config.chromeProfile}`);
  }
  const launchOptions = resolveChromeLaunchOptions(chromeFlags, usingCopiedProfile);
  const launcher = usePatchedLauncher
    ? await launchWithCustomHost({
        chromeFlags: launchOptions.chromeFlags,
        chromePath: config.chromePath ?? undefined,
        userDataDir,
        host: connectHost ?? "127.0.0.1",
        requestedPort: debugPort ?? undefined,
        ignoreDefaultFlags: launchOptions.ignoreDefaultFlags,
        logger,
      })
    : await launch({
        chromePath: config.chromePath ?? undefined,
        chromeFlags: launchOptions.chromeFlags,
        userDataDir,
        handleSIGINT: false,
        port: debugPort ?? undefined,
        ignoreDefaultFlags: launchOptions.ignoreDefaultFlags,
      });
  const coordinatorEndpoint = { host: connectHost ?? "127.0.0.1", port: launcher.port };
  const originalKill = launcher.kill.bind(launcher);
  const clearResourceGate = (): void => {
    if (connectHost) return;
    try {
      clearCoordinatorResourceObservation(coordinatorEndpoint);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`[browser-resource] Failed to clear coordinator resource gate: ${message}`);
    }
  };
  const killOwnedChrome = async (reportFailure: boolean): Promise<void> => {
    try {
      await originalKill();
    } catch (error) {
      if (reportFailure) {
        const message = error instanceof Error ? error.message : String(error);
        logger(`[browser-resource] Chrome shutdown failed: ${message}`);
      }
    } finally {
      clearResourceGate();
    }
  };
  const monitored = Object.assign(launcher, {
    host: connectHost ?? "127.0.0.1",
  }) as MonitoredLaunchedChrome;
  if (!connectHost) {
    if (typeof launcher.pid !== "number") {
      await killOwnedChrome(false);
      throw new BrowserAutomationError(
        "Launched Chrome did not expose a root PID; Oracle closed the unmonitored browser.",
        { stage: "browser-resource-limit", reason: "root_pid_unavailable" },
      );
    }
    let watchdog: BrowserResourceWatchdog;
    try {
      watchdog = await startOwnedChromeResourceWatchdog({
        rootPid: launcher.pid,
        profilePath: userDataDir,
        logger,
        config: {
          pollIntervalMs: config.resourceMonitorIntervalMs,
          rssSoftBytes: config.resourceRssSoftLimitBytes,
          rssHardBytes: config.resourceRssHardLimitBytes,
          rssResumeBytes: config.resourceRssResumeLimitBytes,
        },
        onSample: async (sample, decision) => {
          recordCoordinatorResourceObservation(coordinatorEndpoint, sample, {
            ...decision,
            phase: decision.phase === "resident_grace" ? "soft" : decision.phase,
          });
        },
        onHardLimit: async (error) => {
          logger(`[browser-resource] ${error.message}`);
          await killOwnedChrome(true);
        },
      });
    } catch (error) {
      await killOwnedChrome(false);
      throw error;
    }
    logger(
      `[browser-resource] Monitoring owned Chrome every ${config.resourceMonitorIntervalMs}ms; ` +
        `soft ${(config.resourceRssSoftLimitBytes / 1024 ** 2).toFixed(0)} MiB, ` +
        `hard ${(config.resourceRssHardLimitBytes / 1024 ** 2).toFixed(0)} MiB.`,
    );
    monitored.resourceExhaustion = watchdog.exhaustion;
    monitored.stopResourceWatchdog = () => {
      watchdog.stop();
      clearResourceGate();
    };
    monitored.kill = async () => {
      watchdog.stop();
      await killOwnedChrome(true);
    };
  }
  const pidLabel = typeof launcher.pid === "number" ? ` (pid ${launcher.pid})` : "";
  const hostLabel = connectHost ? ` on ${connectHost}` : "";
  logger(`Launched Chrome${pidLabel} on port ${launcher.port}${hostLabel}`);
  return monitored;
}

export interface LocalChromeResourceMonitor {
  resourceExhaustion: Promise<never>;
  stopResourceWatchdog: () => void;
}

export interface MonitorLocalChromeProcessInput {
  port: number;
  pid: number;
  profileDir: string;
  config: ResolvedBrowserConfig;
  logger: BrowserLogger;
}

export async function monitorLocalChromeProcess(
  input: MonitorLocalChromeProcessInput,
): Promise<LocalChromeResourceMonitor> {
  const { port, pid, profileDir, config, logger } = input;
  const endpoint = { host: "127.0.0.1", port };
  const clearResourceGate = (): void => {
    try {
      clearCoordinatorResourceObservation(endpoint);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`[browser-resource] Failed to clear coordinator resource gate: ${message}`);
    }
  };
  const watchdog = await startOwnedChromeResourceWatchdog({
    rootPid: pid,
    profilePath: profileDir,
    logger,
    config: {
      pollIntervalMs: config.resourceMonitorIntervalMs,
      rssSoftBytes: config.resourceRssSoftLimitBytes,
      rssHardBytes: config.resourceRssHardLimitBytes,
      rssResumeBytes: config.resourceRssResumeLimitBytes,
    },
    onSample: async (sample, decision) => {
      recordCoordinatorResourceObservation(endpoint, sample, {
        ...decision,
        phase: decision.phase === "resident_grace" ? "soft" : decision.phase,
      });
    },
    onHardLimit: async (error, evidence) => {
      logger(`[browser-resource] ${error.message}`);
      if (!evidence) {
        logger(
          "[browser-resource] Adopted Chrome was not terminated because fresh process identity evidence was unavailable.",
        );
        return;
      }
      const result = await terminateVerifiedOwnedChromeTree(evidence);
      if (!result.terminated) {
        logger(
          `[browser-resource] Verified Chrome cleanup was incomplete (${result.reason}); ` +
            `remaining pids: ${result.remainingPids.join(",") || "unknown"}.`,
        );
      }
      clearResourceGate();
    },
  });
  logger(
    `[browser-resource] Monitoring adopted Chrome pid ${pid} every ` +
      `${config.resourceMonitorIntervalMs}ms; soft ` +
      `${(config.resourceRssSoftLimitBytes / 1024 ** 2).toFixed(0)} MiB, hard ` +
      `${(config.resourceRssHardLimitBytes / 1024 ** 2).toFixed(0)} MiB.`,
  );
  return {
    resourceExhaustion: watchdog.exhaustion,
    stopResourceWatchdog: () => {
      watchdog.stop();
      clearResourceGate();
    },
  };
}

export async function monitorAdoptedLocalChrome(
  chrome: LaunchedChrome,
  config: ResolvedBrowserConfig,
  userDataDir: string,
  logger: BrowserLogger,
): Promise<MonitoredLaunchedChrome> {
  if (typeof chrome.pid !== "number") {
    throw new BrowserAutomationError(
      "Oracle refused to reuse Chrome because its root PID could not be verified for memory monitoring.",
      { stage: "browser-resource-limit", reason: "root_pid_unavailable" },
    );
  }
  const monitor = await monitorLocalChromeProcess({
    port: chrome.port,
    pid: chrome.pid,
    profileDir: userDataDir,
    config,
    logger,
  });
  return Object.assign(chrome, {
    host: "127.0.0.1",
    ...monitor,
  }) as MonitoredLaunchedChrome;
}

export async function positionChromeWindowOffscreen(
  client: ChromeClient,
  logger: BrowserLogger,
): Promise<void> {
  if (process.platform !== "darwin") {
    logger("Window hiding is only supported on macOS");
    return;
  }
  try {
    const { windowId } = await client.Browser.getWindowForTarget();
    await client.Browser.setWindowBounds({
      windowId,
      bounds: { left: -32_000, top: -32_000, windowState: "normal" },
    });
    logger("Chrome window positioned off-screen");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to position Chrome window off-screen: ${message}`);
  }
}

export function normalizeHeadlessUserAgent(userAgent: string): string {
  return userAgent.replace(/\bHeadlessChrome\//g, "Chrome/");
}

export async function configureHeadlessUserAgent(
  Network: ChromeClient["Network"],
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<void> {
  if (!Network || typeof Network.setUserAgentOverride !== "function") {
    return;
  }
  try {
    const { result } = await Runtime.evaluate({
      expression: "navigator.userAgent",
      returnByValue: true,
    });
    const currentUserAgent = typeof result?.value === "string" ? result.value : "";
    const userAgent = normalizeHeadlessUserAgent(currentUserAgent);
    if (!userAgent || userAgent === currentUserAgent) {
      return;
    }
    const platform = /Windows/i.test(currentUserAgent)
      ? "Win32"
      : /Linux/i.test(currentUserAgent)
        ? "Linux x86_64"
        : "MacIntel";
    await Network.setUserAgentOverride({
      userAgent,
      acceptLanguage: "en-US,en;q=0.9",
      platform,
    });
    logger("[browser] Normalized headless Chrome user-agent for ChatGPT anti-bot checks");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Headless user-agent normalization unavailable: ${message}`);
  }
}

export function registerTerminationHooks(
  chrome: LaunchedChrome,
  userDataDir: string,
  keepBrowser: boolean,
  logger: BrowserLogger,
  opts?: {
    /** Return true when the run is still in-flight (assistant response pending). */
    isInFlight?: () => boolean;
    /** Persist runtime hints so reattach can find the live Chrome. */
    emitRuntimeHint?: () => Promise<void>;
    /** Preserve the profile directory even when Chrome is terminated. */
    preserveUserDataDir?: boolean;
    /**
     * Always terminate Chrome and delete `userDataDir` on signal, even when the run is
     * in-flight — for throwaway copied profiles (`--copy-profile`) that must not be left
     * on disk. Overrides the in-flight "leave running" behavior.
     */
    forceProfileCleanup?: boolean;
  },
): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGQUIT"];
  let handling: boolean | undefined;

  const handleSignal = (signal: NodeJS.Signals) => {
    if (handling) {
      return;
    }
    handling = true;
    const inFlight = opts?.isInFlight?.() ?? false;
    const forceCleanup = opts?.forceProfileCleanup ?? false;
    const leaveRunning = (keepBrowser || inFlight) && !forceCleanup;
    if (leaveRunning) {
      logger(
        `Received ${signal}; leaving Chrome running${inFlight ? " (assistant response pending)" : ""}`,
      );
    } else if (forceCleanup && (keepBrowser || inFlight)) {
      logger(
        `Received ${signal}; terminating Chrome and removing the copied profile (copy-profile is not retained)`,
      );
    } else {
      logger(`Received ${signal}; terminating Chrome process`);
    }
    void (async () => {
      if (leaveRunning) {
        // Ensure reattach hints are written before we exit.
        await opts?.emitRuntimeHint?.().catch(() => undefined);
        if (inFlight) {
          logger('Session still in flight; reattach with "oracle session <slug>" to continue.');
        }
      } else {
        try {
          await chrome.kill();
        } catch {
          // ignore kill failures
        }
        if (opts?.preserveUserDataDir) {
          // Preserve the profile directory (manual login), but clear reattach hints so we don't
          // try to reuse a dead DevTools port on the next run.
          await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
            () => undefined,
          );
        } else {
          await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    })().finally(() => {
      const exitCode = signal === "SIGINT" ? 130 : 1;
      // Vitest treats any `process.exit()` call as an unhandled failure, even if mocked.
      // Keep production behavior (hard-exit on signals) while letting tests observe state changes.
      process.exitCode = exitCode;
      const isTestRun = process.env.VITEST === "1" || process.env.NODE_ENV === "test";
      if (!isTestRun) {
        process.exit(exitCode);
      }
    });
  };

  for (const signal of signals) {
    process.on(signal, handleSignal);
  }

  return () => {
    for (const signal of signals) {
      process.removeListener(signal, handleSignal);
    }
  };
}

export async function connectToChrome(
  port: number,
  logger: BrowserLogger,
  host?: string,
): Promise<ChromeClient> {
  const client = await CDP({ port, host });
  logger("Connected to Chrome DevTools protocol");
  return client;
}

export async function connectToRemoteChrome(
  host: string,
  port: number,
  logger: BrowserLogger,
  targetUrl?: string,
  browserWSEndpoint?: string,
  options?: {
    approvalWaitMs?: number;
    maxTabs?: number;
    coordinator?: CoordinatorRuntimeOptions;
    role?: BrowserCoordinatorTargetRole;
  },
): Promise<RemoteChromeConnection> {
  const coordinatorOptions = options?.coordinator;
  const role = options?.role;
  if (browserWSEndpoint) {
    return await connectToRemoteChromeTarget(host, port, logger, {
      browserWSEndpoint,
      targetUrl: targetUrl ?? "about:blank",
      closeTargetOnDispose: true,
      approvalWaitMs: options?.approvalWaitMs,
      coordinator: coordinatorOptions,
      role,
    });
  }
  if (targetUrl) {
    await pruneRemoteChromeTargets(host, port, logger, {
      maxTabs: options?.maxTabs ?? DEFAULT_REMOTE_CHROME_MAX_TABS,
      reserveSlots: 1,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger(`[tabs] failed to prune remote Chrome tabs before open: ${message}`);
    });
    const targetConnection = await connectToNewTarget(host, port, targetUrl, logger, {
      opened: () => `Opened dedicated remote Chrome tab targeting ${targetUrl}`,
      openFailed: (message) =>
        `Failed to open dedicated remote Chrome tab (${message}); falling back to first target.`,
      attachFailed: (targetId, message) =>
        `Failed to attach to dedicated remote Chrome tab ${targetId} (${message}); falling back to first target.`,
      closeFailed: (targetId, message) =>
        `Failed to close unused remote Chrome tab ${targetId}: ${message}`,
      coordinator: coordinatorOptions,
      role,
    });
    if (targetConnection) {
      await recordRemoteChromeTarget(host, port, targetConnection.targetId, targetUrl).catch(
        (error) => {
          const message = error instanceof Error ? error.message : String(error);
          logger(
            `[tabs] failed to record remote Chrome tab ${targetConnection.targetId}: ${message}`,
          );
        },
      );
      return {
        client: targetConnection.client,
        targetId: targetConnection.targetId,
        detach: targetConnection.detach,
        close: async () => {
          await targetConnection.client.close().catch(() => undefined);
          await closeRemoteChromeTarget(host, port, targetConnection.targetId, logger, {
            coordinator: coordinatorOptions,
          });
        },
      };
    }
  }
  const fallbackClient = await CDP({ host, port });
  logger(`Connected to remote Chrome DevTools protocol at ${host}:${port}`);
  return {
    client: fallbackClient,
    detach: async () => {
      await fallbackClient.close().catch(() => undefined);
    },
    close: async () => {
      await fallbackClient.close().catch(() => undefined);
    },
  };
}

export async function closeRemoteChromeTarget(
  host: string,
  port: number,
  targetId: string | undefined,
  logger: BrowserLogger,
  options?: { coordinator?: CoordinatorRuntimeOptions },
): Promise<void> {
  if (!targetId) {
    return;
  }
  let confirmed = false;
  try {
    await closeRemoteChromePageTarget(host, port, targetId);
    confirmed = await remoteTargetIsAbsent(host, port, targetId);
    if (logger.verbose) {
      logger(`Closed remote Chrome tab ${targetId}`);
    }
  } catch (error) {
    confirmed = await remoteTargetIsAbsent(host, port, targetId);
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to close remote Chrome tab ${targetId}: ${message}`);
  } finally {
    await finalizeCoordinatorTarget(host, port, targetId, confirmed, options?.coordinator).catch(
      () => undefined,
    );
    await forgetRemoteChromeTarget(host, port, targetId).catch(() => undefined);
  }
}
async function remoteTargetIsAbsent(
  host: string,
  port: number,
  targetId: string,
): Promise<boolean> {
  try {
    const targets = (await CDP.List({ host, port })) as Array<{ id?: string; targetId?: string }>;
    return !targets.some((target) => (target.targetId ?? target.id) === targetId);
  } catch {
    return false;
  }
}

export interface RemoteChromeConnection {
  client: ChromeClient;
  targetId?: string;
  browserWSEndpoint?: string;
  detach: () => Promise<void>;
  close: () => Promise<void>;
}

export interface IsolatedTabConnection {
  client: ChromeClient;
  targetId?: string;
}

interface TargetConnectMessages {
  opened?: (targetId: string) => string;
  openFailed: (message: string) => string;
  attachFailed: (targetId: string, message: string) => string;
  closeFailed: (targetId: string, message: string) => string;
}

export interface RemoteTargetInfo {
  targetId?: string;
  type?: string;
  url?: string;
}

export async function listRemoteChromeTargets(options: {
  host: string;
  port: number;
  browserWSEndpoint?: string;
}): Promise<RemoteTargetInfo[]> {
  if (!options.browserWSEndpoint) {
    const targets = await CDP.List({ host: options.host, port: options.port });
    return targets as unknown as RemoteTargetInfo[];
  }
  const browser = await CDP({ target: options.browserWSEndpoint, local: true });
  try {
    const result = await browser.Target.getTargets();
    return (result.targetInfos ?? []).map((target) => ({
      targetId: target.targetId,
      type: target.type,
      url: target.url,
    }));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function connectToRemoteChromeTarget(
  host: string,
  port: number,
  logger: BrowserLogger,
  options: {
    targetId?: string;
    targetUrl?: string;
    browserWSEndpoint?: string;
    closeTargetOnDispose?: boolean;
    approvalWaitMs?: number;
    coordinator?: CoordinatorRuntimeOptions;
    role?: BrowserCoordinatorTargetRole;
  },
): Promise<RemoteChromeConnection> {
  let lease: CoordinatorTargetLease | undefined;
  const coordinatorOptions = options.coordinator ?? {
    ownerStartToken: `controller:${process.pid}`,
  };
  const createdByOracle = !options.targetId;
  if (!options.browserWSEndpoint) {
    if (options.targetId) {
      lease = await attachCoordinatorTarget(host, port, options.targetId, {
        ...coordinatorOptions,
        role: options.role,
      });
    }
    try {
      const client = await CDP({ host, port, target: options.targetId });
      return {
        client,
        targetId: options.targetId,
        detach: async () => {
          await client.close().catch(() => undefined);
          await lease?.markLost();
        },
        close: async () => {
          await client.close().catch(() => undefined);
          await lease?.release();
        },
      };
    } catch (error) {
      await lease?.release();
      throw error;
    }
  }

  const browser = await connectToBrowserWebSocket(
    host,
    port,
    options.browserWSEndpoint,
    logger,
    options.approvalWaitMs,
  );
  try {
    if (options.targetId) {
      lease = await attachCoordinatorTarget(host, port, options.targetId, {
        ...coordinatorOptions,
        role: options.role,
      });
    }
    if (!options.targetId) {
      lease = await reserveCoordinatorTarget(host, port, {
        ...coordinatorOptions,
        role: options.role,
        url: options.targetUrl ?? "about:blank",
      });
    }
    let targetId = options.targetId;
    if (!targetId) {
      const created = await browser.Target.createTarget({
        url: options.targetUrl ?? "about:blank",
      });
      if (!created.targetId) {
        await lease?.release();
        throw new Error("Chrome returned no target id.");
      }
      targetId = created.targetId;
      await lease?.bind(targetId, options.targetUrl ?? "about:blank");
      logger(`Opened dedicated remote Chrome tab targeting ${options.targetUrl ?? "about:blank"}`);
    }
    const attached = await browser.Target.attachToTarget({ targetId, flatten: true });
    const client = createSessionBoundChromeClient(browser, attached.sessionId);
    return {
      client,
      targetId,
      browserWSEndpoint: options.browserWSEndpoint,
      detach: async () => {
        await browser.Target.detachFromTarget({ sessionId: attached.sessionId }).catch(
          () => undefined,
        );
        await lease?.markLost();
        await browser.close().catch(() => undefined);
      },
      close: async () => {
        await browser.Target.detachFromTarget({ sessionId: attached.sessionId }).catch(
          () => undefined,
        );
        if (options.closeTargetOnDispose && targetId) {
          const result = await browser.Target.closeTarget({ targetId }).catch(() => undefined);
          await lease?.release({ confirmed: result?.success !== false });
        } else {
          await lease?.release();
        }
        await browser.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await lease?.[createdByOracle ? "markLost" : "release"]();
    await browser.close().catch(() => undefined);
    throw error;
  }
}

async function connectToBrowserWebSocket(
  host: string,
  port: number,
  browserWSEndpoint: string,
  logger: BrowserLogger,
  approvalWaitMs?: number,
): Promise<ChromeClient> {
  if (!approvalWaitMs || approvalWaitMs <= 0) {
    return (await CDP({ target: browserWSEndpoint, local: true })) as ChromeClient;
  }

  logger(`Waiting for Chrome remote debugging approval for ${host}:${port}...`);

  const deadline = Date.now() + approvalWaitMs;
  let lastApprovalError: unknown;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    try {
      return await Promise.race([
        CDP({ target: browserWSEndpoint, local: true }) as Promise<ChromeClient>,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error("__oracle_remote_debugging_approval_timeout__"));
          }, remainingMs);
        }),
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "__oracle_remote_debugging_approval_timeout__"
      ) {
        break;
      }
      if (!isRemoteDebuggingApprovalError(error)) {
        throw error;
      }
      lastApprovalError = error;
      await delay(Math.min(500, Math.max(0, deadline - Date.now())));
    }
  }
  const suffix =
    lastApprovalError instanceof Error && lastApprovalError.message
      ? ` Last Chrome response: ${lastApprovalError.message}`
      : "";
  throw new Error(
    `Oracle waited ${formatApprovalWait(approvalWaitMs)} for Chrome remote debugging approval at ${host}:${port}. Allow the Chrome prompt or retry after toggling remote debugging.${suffix}`,
  );
}

function isRemoteDebuggingApprovalError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /unexpected server response:\s*403|remote debugging|forbidden/i.test(message);
}

function formatApprovalWait(waitMs: number): string {
  if (waitMs % 1000 === 0) {
    return `${waitMs / 1000}s`;
  }
  return `${waitMs}ms`;
}

async function discardCreatedChromeTarget(
  host: string,
  port: number,
  targetId: string,
  lease: CoordinatorTargetLease,
  logger: BrowserLogger,
  closeFailed: (targetId: string, message: string) => string,
): Promise<void> {
  let closeError: unknown;
  let closeConfirmed = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await CDP.Close({ host, port, id: targetId });
      closeError = undefined;
    } catch (error) {
      closeError = error;
    }
    closeConfirmed = await remoteTargetIsAbsent(host, port, targetId);
    if (closeConfirmed) break;
    if (attempt < 2) await delay(50 * (attempt + 1));
  }

  let leaseError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (closeConfirmed) await lease.release({ confirmed: true });
      else await lease.markLost();
      leaseError = undefined;
      break;
    } catch (error) {
      leaseError = error;
      if (attempt < 2) await delay(50 * (attempt + 1));
    }
  }
  if (closeConfirmed && !leaseError) return;

  const closeMessage = closeConfirmed
    ? "Chrome target closure was confirmed"
    : closeError instanceof Error
      ? closeError.message
      : "Chrome target remained present after three close attempts";
  const leaseMessage = leaseError
    ? `; coordinator release failed: ${leaseError instanceof Error ? leaseError.message : String(leaseError)}`
    : "";
  const message = `${closeMessage}${leaseMessage}`;
  logger(closeFailed(targetId, message));
  throw new BrowserAutomationError(
    `Failed to discard Chrome target ${targetId}: ${message}`,
    {
      stage: "browser-coordinator",
      code: "target-cleanup-failed",
      targetId,
      closeConfirmed,
      leaseReleased: !leaseError,
    },
    leaseError ?? closeError,
  );
}

async function connectToNewTarget(
  host: string,
  port: number,
  url: string,
  logger: BrowserLogger,
  messages: TargetConnectMessages & {
    coordinator?: CoordinatorRuntimeOptions;
    role?: BrowserCoordinatorTargetRole;
  },
): Promise<{
  client: ChromeClient;
  targetId: string;
  detach: () => Promise<void>;
} | null> {
  const lease = await reserveCoordinatorTarget(host, port, {
    ...(messages.coordinator ?? { ownerStartToken: `controller:${process.pid}` }),
    role: messages.role,
    url,
  });
  let targetId: string | undefined;
  let discardAttempted = false;
  try {
    const target = await CDP.New({ host, port, url });
    targetId = target.id;
    if (!targetId) {
      await lease.release();
      logger(messages.openFailed("Chrome returned no target id"));
      return null;
    }
    await lease.bind(targetId, url);
    try {
      const client = await CDP({ host, port, target: targetId });
      if (messages.opened) logger(messages.opened(targetId));
      return {
        client,
        targetId,
        detach: async () => {
          await client.close().catch(() => undefined);
          await lease.markLost();
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(messages.attachFailed(targetId, message));
      discardAttempted = true;
      await discardCreatedChromeTarget(host, port, targetId, lease, logger, messages.closeFailed);
    }
  } catch (error) {
    if (targetId && !discardAttempted) {
      await discardCreatedChromeTarget(host, port, targetId, lease, logger, messages.closeFailed);
    } else if (!targetId) {
      await lease.release();
    }
    if (error instanceof BrowserAutomationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    logger(messages.openFailed(message));
  }
  return null;
}

function createSessionBoundChromeClient(browser: ChromeClient, sessionId: string): ChromeClient {
  const browserWithEvents = browser as ChromeClient & {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    once: (event: string, listener: (...args: unknown[]) => void) => void;
    off?: (event: string, listener: (...args: unknown[]) => void) => void;
    removeListener: (event: string, listener: (...args: unknown[]) => void) => void;
  };
  const bindDomain = <T extends object>(domainName: string): T => {
    const domain = (browser as unknown as Record<string, Record<string, unknown>>)[domainName] as
      | Record<string, unknown>
      | undefined;
    const eventName = (name: string) => `${domainName}.${name}.${sessionId}`;
    return new Proxy((domain ?? {}) as T, {
      get(target, prop, receiver) {
        if (prop === "on") {
          return (name: string, listener: (...args: unknown[]) => void) => {
            const domainEvent = (target as Record<string, unknown>)[name];
            if (typeof domainEvent === "function") {
              return (domainEvent as (...args: unknown[]) => unknown)(sessionId, listener);
            }
            browserWithEvents.on(eventName(name), listener);
            return () => browserWithEvents.removeListener(eventName(name), listener);
          };
        }
        if (prop === "off" || prop === "removeListener") {
          return (name: string, listener: (...args: unknown[]) => void) => {
            const off =
              browserWithEvents.off ?? browserWithEvents.removeListener.bind(browserWithEvents);
            off(eventName(name), listener);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) =>
          (value as (...callArgs: unknown[]) => unknown)(...args, sessionId);
      },
    });
  };

  return {
    ...browser,
    // Raw `send` here is the browser-level send (not session-bound), so callers
    // that issue Target.* via `send` must pass this page session id explicitly to
    // stay scoped to this tab (e.g. Deep Research OOPIF auto-attach).
    // chrome-remote-interface defines `send` on the client prototype, so object
    // spread does not preserve it. Bind it explicitly for raw session commands.
    send: typeof browser.send === "function" ? browser.send.bind(browser) : undefined,
    oraclePageSessionId: sessionId,
    Network: bindDomain("Network"),
    Page: bindDomain("Page"),
    Runtime: bindDomain("Runtime"),
    Input: bindDomain("Input"),
    DOM: bindDomain("DOM"),
    Emulation: bindDomain("Emulation"),
    on: browserWithEvents.on.bind(browserWithEvents),
    once: browserWithEvents.once.bind(browserWithEvents),
    off:
      browserWithEvents.off?.bind(browserWithEvents) ??
      browserWithEvents.removeListener.bind(browserWithEvents),
    removeListener: browserWithEvents.removeListener.bind(browserWithEvents),
    close: async () => {
      await browser.Target.detachFromTarget({ sessionId }).catch(() => undefined);
    },
  } as ChromeClient;
}

export async function connectWithNewTab(
  port: number,
  logger: BrowserLogger,
  initialUrl?: string,
  host?: string,
  options?: {
    fallbackToDefault?: boolean;
    retries?: number;
    retryDelayMs?: number;
    coordinator?: CoordinatorRuntimeOptions;
    role?: BrowserCoordinatorTargetRole;
  },
): Promise<IsolatedTabConnection> {
  const effectiveHost = host ?? "127.0.0.1";
  const url = initialUrl ?? "about:blank";
  const fallbackToDefault = options?.fallbackToDefault ?? true;
  const retries = Math.max(0, options?.retries ?? 0);
  const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 250);
  const fallbackLabel = fallbackToDefault
    ? "falling back to default target."
    : "strict mode: not falling back.";

  let attempt = 0;
  while (attempt <= retries) {
    const targetConnection = await connectToNewTarget(effectiveHost, port, url, logger, {
      opened: (targetId) => `Opened isolated browser tab (target=${targetId})`,
      openFailed: (message) => `Failed to open isolated browser tab (${message}); ${fallbackLabel}`,
      attachFailed: (targetId, message) =>
        `Failed to attach to isolated browser tab ${targetId} (${message}); ${fallbackLabel}`,
      closeFailed: (targetId, message) =>
        `Failed to close unused browser tab ${targetId}: ${message}`,
      coordinator: options?.coordinator,
      role: options?.role,
    });
    if (targetConnection) {
      return targetConnection;
    }
    if (attempt >= retries) {
      break;
    }
    attempt += 1;
    await delay(retryDelayMs * attempt);
  }

  if (!fallbackToDefault) {
    throw new Error("Failed to open isolated browser tab; refusing to attach to default target.");
  }
  const client = await connectToChrome(port, logger, effectiveHost);
  return { client };
}

export async function closeTab(
  port: number,
  targetId: string,
  logger: BrowserLogger,
  host?: string,
  options?: { coordinator?: CoordinatorRuntimeOptions },
): Promise<boolean> {
  const effectiveHost = host ?? "127.0.0.1";
  let confirmed = false;
  try {
    await CDP.Close({ host: effectiveHost, port, id: targetId });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(25);
      let targets: Array<{ id?: string; targetId?: string }>;
      try {
        targets = (await CDP.List({ host: effectiveHost, port })) as Array<{
          id?: string;
          targetId?: string;
        }>;
      } catch {
        continue;
      }
      if (!targets.some((target) => (target.targetId ?? target.id) === targetId)) {
        confirmed = true;
        logger(`Closed isolated browser tab (target=${targetId})`);
        break;
      }
    }
    if (!confirmed) logger(`Browser tab close was not confirmed (target=${targetId})`);
  } catch (error) {
    confirmed = await remoteTargetIsAbsent(effectiveHost, port, targetId);
    if (confirmed) logger(`Closed isolated browser tab (target=${targetId})`);
    else {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to close browser tab ${targetId}: ${message}`);
    }
  }
  await finalizeCoordinatorTarget(
    effectiveHost,
    port,
    targetId,
    confirmed,
    options?.coordinator,
  ).catch(() => undefined);
  return confirmed;
}

export async function createChromePageTarget(
  port: number,
  logger: BrowserLogger,
  host?: string,
  options?: { coordinator?: CoordinatorRuntimeOptions; role?: BrowserCoordinatorTargetRole },
): Promise<string | undefined> {
  const effectiveHost = host ?? "127.0.0.1";
  const lease = await reserveCoordinatorTarget(effectiveHost, port, {
    ...(options?.coordinator ?? { ownerStartToken: `controller:${process.pid}` }),
    role: options?.role,
    url: "about:blank",
  });
  let createdTargetId: string | undefined;
  try {
    const created = (await CDP.New({
      host: effectiveHost,
      port,
      url: "about:blank",
    })) as { id?: string; targetId?: string };
    createdTargetId = created.targetId ?? created.id;
    if (!createdTargetId) {
      await lease.release();
      logger("Failed to create a replacement Chrome tab.");
      return undefined;
    }
    await lease.bind(createdTargetId, "about:blank");
    logger(`Opened replacement Chrome tab (target=${createdTargetId})`);
    return createdTargetId;
  } catch (error) {
    if (createdTargetId) {
      await discardCreatedChromeTarget(
        effectiveHost,
        port,
        createdTargetId,
        lease,
        logger,
        (targetId, message) => `Failed to close replacement Chrome tab ${targetId}: ${message}`,
      );
    } else {
      await lease.release();
    }
    if (error instanceof BrowserAutomationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to create a replacement Chrome tab: ${message}`);
    return undefined;
  }
}

export async function ensureChromePageTargetAfterClose(
  port: number,
  closingTargetId: string,
  logger: BrowserLogger,
  host?: string,
  options?: { coordinator?: CoordinatorRuntimeOptions; role?: BrowserCoordinatorTargetRole },
): Promise<string | undefined> {
  const effectiveHost = host ?? "127.0.0.1";
  try {
    const targets = (await CDP.List({ host: effectiveHost, port })) as Array<{
      id?: string;
      targetId?: string;
      type?: string;
    }>;
    const existingPageTargetId = targets
      .filter((target) => target.type === "page")
      .map((target) => target.targetId ?? target.id)
      .find((targetId): targetId is string => Boolean(targetId) && targetId !== closingTargetId);
    if (existingPageTargetId) {
      return existingPageTargetId;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to inspect Chrome tabs before closing ${closingTargetId}: ${message}`);
  }
  return await createChromePageTarget(port, logger, host, options);
}

export async function closeBlankChromeTabs(
  port: number,
  logger: BrowserLogger,
  host?: string,
  options?: {
    excludeTargetIds?: Iterable<string | null | undefined>;
    preserveOneBlank?: boolean;
  },
): Promise<void> {
  const effectiveHost = host ?? "127.0.0.1";
  const excluded = new Set(
    [...(options?.excludeTargetIds ?? [])].filter(
      (targetId): targetId is string => typeof targetId === "string" && targetId.length > 0,
    ),
  );
  let targets: Array<{ id?: string; targetId?: string; type?: string; url?: string }>;
  try {
    targets = (await CDP.List({ host: effectiveHost, port })) as Array<{
      id?: string;
      targetId?: string;
      type?: string;
      url?: string;
    }>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to inspect blank Chrome tabs: ${message}`);
    return;
  }

  const preservedBlankTargetId = options?.preserveOneBlank
    ? targets
        .filter(isBlankPageTarget)
        .map((target) => target.targetId ?? target.id)
        .filter((targetId): targetId is string => Boolean(targetId))
        .sort()[0]
    : undefined;
  let closed = 0;
  for (const target of targets) {
    const targetId = target.targetId ?? target.id;
    if (
      !targetId ||
      targetId === preservedBlankTargetId ||
      excluded.has(targetId) ||
      !isBlankPageTarget(target)
    ) {
      continue;
    }
    try {
      await CDP.Close({ host: effectiveHost, port, id: targetId });
      closed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to close blank Chrome tab ${targetId}: ${message}`);
    }
  }
  if (closed > 0) {
    logger(`Closed ${closed} blank Chrome tab${closed === 1 ? "" : "s"}.`);
  }
}

function isBlankPageTarget(target: { type?: string; url?: string }): boolean {
  if (target.type && target.type !== "page") {
    return false;
  }
  const url = (target.url ?? "").trim().toLowerCase();
  return url === "about:blank" || url === "chrome://newtab/" || url === "chrome://new-tab-page/";
}

function buildChromeFlags(
  headless: boolean,
  debugBindAddress?: string | null,
  hideWindow = false,
): string[] {
  const flags = [
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-default-apps",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--no-first-run",
    "--safebrowsing-disable-auto-update",
    "--disable-features=TranslateUI,AutomationControlled",
    "--mute-audio",
    "--window-size=1280,720",
    // Chrome that *we* launch is pinned to English, so ChatGPT renders the labels
    // our selectors were written against. This does not make English the only case
    // to handle: --browser-attach-running and --remote-chrome never build these
    // flags (see controlPlan.ts), so those runs inherit the user's own Chrome
    // locale, and a ChatGPT account language setting can localize the UI even here.
    // That is why the model/effort matchers must stay language-tolerant.
    "--lang=en-US",
    "--accept-lang=en-US,en",
  ];

  if (process.platform !== "win32" && !isWsl()) {
    flags.push("--password-store=basic", "--use-mock-keychain");
  }

  if (debugBindAddress) {
    flags.push(`--remote-debugging-address=${debugBindAddress}`);
  }

  if (headless) {
    flags.push("--headless=new");
  } else if (hideWindow && process.platform === "darwin") {
    // Cmd-H stops macOS Chrome from compositing the page, which can swallow
    // trusted CDP clicks and retain the prompt as a draft. Keeping the window
    // off-screen avoids desktop disruption while preserving normal rendering.
    flags.push("--window-position=-32000,-32000");
  }

  // Opt-in only: container/CI Chromium often cannot use the sandbox. Callers must
  // set ORACLE_CHROME_NO_SANDBOX=1 explicitly (never default this on).
  if (process.env.ORACLE_CHROME_NO_SANDBOX === "1") {
    flags.push("--no-sandbox", "--disable-dev-shm-usage");
  }

  return flags;
}

export function buildChromeFlagsForTest(
  headless: boolean,
  debugBindAddress?: string | null,
  hideWindow = false,
): string[] {
  return buildChromeFlags(headless, debugBindAddress, hideWindow);
}

function resolveChromeLaunchOptions(
  chromeFlags: string[],
  usingCopiedProfile: boolean,
): { chromeFlags: string[]; ignoreDefaultFlags: boolean } {
  if (!usingCopiedProfile) {
    return { chromeFlags, ignoreDefaultFlags: false };
  }
  return {
    chromeFlags: [...Launcher.defaultFlags(), ...chromeFlags].filter(
      (flag) => flag !== "--use-mock-keychain" && flag !== "--password-store=basic",
    ),
    ignoreDefaultFlags: true,
  };
}

export function resolveChromeLaunchOptionsForTest(
  chromeFlags: string[],
  usingCopiedProfile: boolean,
): { chromeFlags: string[]; ignoreDefaultFlags: boolean } {
  return resolveChromeLaunchOptions(chromeFlags, usingCopiedProfile);
}

function parseDebugPortEnv(): number | null {
  const raw = process.env.ORACLE_BROWSER_PORT ?? process.env.ORACLE_BROWSER_DEBUG_PORT;
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0 || value > 65535) {
    return null;
  }
  return value;
}

export async function ensureWindowsChromeDevtoolsBridge(options: {
  host: string;
  port: number;
  chromePid?: number;
  logger: BrowserLogger;
  timeoutMs?: number;
}): Promise<void> {
  const host = options.host.trim();
  if (!host || host === "127.0.0.1" || !isWsl()) {
    return;
  }
  if (await isTcpPortReachable(host, options.port, 250)) {
    return;
  }
  spawnWindowsChromeDevtoolsBridge(host, options.port, options.chromePid);
  await waitForTcpPort(host, options.port, options.timeoutMs ?? 15_000).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    options.logger(
      `Failed to expose Windows Chrome DevTools on ${host}:${options.port}: ${message}`,
    );
    throw error;
  });
}

function shouldBridgeWslWindowsChrome(
  chromePath: string | null | undefined,
  host: string | null,
): boolean {
  if (!isWsl()) {
    return false;
  }
  const normalizedHost = host?.trim() ?? "";
  if (!normalizedHost || normalizedHost === "127.0.0.1") {
    return false;
  }
  const value = (chromePath ?? "").trim();
  if (!value) {
    return true;
  }
  return (/[a-z]:\\/i.test(value) || /^\/mnt\/[a-z]\//i.test(value)) && /\.exe$/i.test(value);
}

function spawnWindowsChromeDevtoolsBridge(host: string, port: number, chromePid?: number): void {
  const encoded = Buffer.from(
    buildWindowsChromeBridgeScript(host, port, chromePid),
    "utf16le",
  ).toString("base64");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
}

function buildWindowsChromeBridgeScript(host: string, port: number, chromePid?: number): string {
  const pidExpr =
    Number.isFinite(chromePid) && (chromePid ?? 0) > 0 ? `${Math.trunc(chromePid ?? 0)}` : "0";
  return `
$ErrorActionPreference = 'SilentlyContinue'
$listenAddress = '${host.replace(/'/g, "''")}'
$port = ${Math.trunc(port)}
$chromePid = ${pidExpr}
$startupDeadline = (Get-Date).AddSeconds(30)
$listener = $null
$bridges = [System.Collections.ArrayList]::new()
function Close-BridgeConnection {
  param($Bridge)
  if (-not $Bridge) { return }
  if ($Bridge.IncomingStream) { $Bridge.IncomingStream.Dispose() }
  if ($Bridge.OutgoingStream) { $Bridge.OutgoingStream.Dispose() }
  if ($Bridge.Incoming) { $Bridge.Incoming.Dispose() }
  if ($Bridge.Outgoing) { $Bridge.Outgoing.Dispose() }
}
function Resolve-ChromePid {
  try {
    $connection = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($connection -and $connection.OwningProcess) {
      return [int]$connection.OwningProcess
    }
  } catch {
  }
  return 0
}
try {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($listenAddress), $port)
  $listener.Server.SetSocketOption([System.Net.Sockets.SocketOptionLevel]::Socket, [System.Net.Sockets.SocketOptionName]::ReuseAddress, $true)
  $listener.Start()
} catch {
  exit 0
}
try {
  while ($true) {
    if ($chromePid -le 0) {
      $chromePid = Resolve-ChromePid
      if ($chromePid -le 0 -and (Get-Date) -gt $startupDeadline) { break }
    } else {
      $chrome = Get-Process -Id $chromePid -ErrorAction SilentlyContinue
      if (-not $chrome) { break }
    }
    if (-not $listener.Pending()) {
      Start-Sleep -Milliseconds 100
    } else {
      $incoming = $null
      $outgoing = $null
      $incomingStream = $null
      $outgoingStream = $null
      try {
        $incoming = $listener.AcceptTcpClient()
        $outgoing = [System.Net.Sockets.TcpClient]::new()
        $outgoing.Connect('127.0.0.1', $port)
        $incomingStream = $incoming.GetStream()
        $outgoingStream = $outgoing.GetStream()
        $copyIn = $incomingStream.CopyToAsync($outgoingStream)
        $copyOut = $outgoingStream.CopyToAsync($incomingStream)
        $completion = [System.Threading.Tasks.Task]::WhenAll(@($copyIn, $copyOut))
        $null = $bridges.Add([pscustomobject]@{
          Incoming = $incoming
          Outgoing = $outgoing
          IncomingStream = $incomingStream
          OutgoingStream = $outgoingStream
          Completion = $completion
        })
        $incoming = $null
        $outgoing = $null
        $incomingStream = $null
        $outgoingStream = $null
      } catch {
        if ($incomingStream) { $incomingStream.Dispose() }
        if ($outgoingStream) { $outgoingStream.Dispose() }
        if ($incoming) { $incoming.Dispose() }
        if ($outgoing) { $outgoing.Dispose() }
      }
    }
    foreach ($bridge in @($bridges)) {
      if (-not $bridge.Completion.IsCompleted) { continue }
      Close-BridgeConnection $bridge
      [void] $bridges.Remove($bridge)
    }
  }
} finally {
  foreach ($bridge in @($bridges)) {
    Close-BridgeConnection $bridge
  }
  if ($listener) { $listener.Stop() }
}
`.trim();
}

async function waitForDevtoolsHttpReady(
  host: string,
  port: number,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unreachable";
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const response = await fetch(`http://${host}:${port}/json/version`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for DevTools HTTP at ${host}:${port}: ${lastError}`);
}

async function isTcpPortReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  try {
    await waitForTcpPort(host, port, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function waitForTcpPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unreachable";
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        const cleanup = () => {
          socket.removeAllListeners();
          socket.end();
          socket.destroy();
        };
        socket.setTimeout(Math.min(1000, timeoutMs));
        socket.once("connect", () => {
          cleanup();
          resolve();
        });
        socket.once("timeout", () => {
          cleanup();
          reject(new Error("timeout"));
        });
        socket.once("error", (error) => {
          cleanup();
          reject(error);
        });
      });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await delay(250);
    }
  }
  throw new Error(`Timed out waiting for TCP ${host}:${port}: ${lastError}`);
}

function isWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME) {
    return true;
  }
  if (process.platform !== "linux") {
    return false;
  }
  const release = os.release();
  return release.toLowerCase().includes("microsoft");
}
async function launchWithCustomHost({
  chromeFlags,
  chromePath,
  userDataDir,
  host,
  requestedPort,
  ignoreDefaultFlags,
  logger,
}: {
  chromeFlags: string[];
  chromePath?: string | null;
  userDataDir: string;
  host: string | null;
  requestedPort?: number;
  ignoreDefaultFlags?: boolean;
  logger: BrowserLogger;
}): Promise<LaunchedChrome & { host?: string }> {
  const launcher = new Launcher({
    chromePath: chromePath ?? undefined,
    chromeFlags,
    userDataDir,
    handleSIGINT: false,
    port: requestedPort ?? undefined,
    ignoreDefaultFlags,
  });

  if (host) {
    const patched = launcher as unknown as { isDebuggerReady?: () => Promise<void>; port?: number };
    patched.isDebuggerReady = function patchedIsDebuggerReady(
      this: Launcher & { port?: number; pid?: number },
    ): Promise<void> {
      const debugPort = this.port ?? 0;
      if (!debugPort) {
        return Promise.reject(new Error("Missing Chrome debug port"));
      }
      return (async () => {
        if (shouldBridgeWslWindowsChrome(chromePath, host)) {
          await ensureWindowsChromeDevtoolsBridge({
            host,
            port: debugPort,
            chromePid: this.pid,
            logger,
          });
        }
        await waitForDevtoolsHttpReady(host, debugPort);
      })();
    };
  }

  await launcher.launch();

  const kill = async () => launcher.kill();
  return {
    pid: launcher.pid ?? undefined,
    port: launcher.port ?? 0,
    process: launcher.chromeProcess as unknown as NonNullable<LaunchedChrome["process"]>,
    kill,
    host: host ?? undefined,
    remoteDebuggingPipes: launcher.remoteDebuggingPipes,
  } as unknown as LaunchedChrome & { host?: string };
}

export const __test__ = {
  buildWindowsChromeBridgeScript,
  shouldBridgeWslWindowsChrome,
};
