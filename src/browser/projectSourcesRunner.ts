import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LaunchedChrome } from "chrome-launcher";
import {
  closeTab,
  connectWithNewTab,
  launchChrome,
  monitorAdoptedLocalChrome,
  positionChromeWindowOffscreen,
  registerTerminationHooks,
} from "./chromeLifecycle.js";
import { resolveBrowserConfig } from "./config.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import {
  installJavaScriptDialogAutoDismissal,
  navigateToChatGPT,
  ensureLoggedIn,
} from "./pageActions.js";
import type { BrowserLogger, ChromeClient, ResolvedBrowserConfig } from "./types.js";
import {
  cleanupStaleProfileState,
  findRunningChromeDebugTargetForProfile,
  readChromePid,
  readDevToolsPort,
  shouldCleanupManualLoginProfileState,
  verifyDevToolsReachable,
  withProfileLaunchLock,
  writeChromePid,
  writeDevToolsActivePort,
} from "./profileState.js";
import { CHATGPT_URL } from "./constants.js";
import { delay } from "./utils.js";
import {
  assertManualLoginProfileReadyForRun,
  defaultManualLoginProfileDir,
  formatManualLoginSetupCommand,
  resolveManualLoginWaitMs,
} from "./manualLoginProfile.js";
import {
  openProjectSourcesTab,
  uploadProjectSources,
  waitForProjectSourcesReady,
  waitForProjectSourcesListSettled,
} from "./actions/projectSources.js";
import { normalizeProjectSourcesUrl } from "../projectSources/url.js";
import { buildProjectSourcesUploadPlan, diffAddedProjectSources } from "../projectSources/plan.js";
import type { ProjectSourcesRequest, ProjectSourcesResult } from "../projectSources/types.js";

type BrowserChrome = LaunchedChrome & {
  host?: string;
  resourceExhaustion?: Promise<never>;
  stopResourceWatchdog?: () => void;
};

export async function runBrowserProjectSources(
  request: ProjectSourcesRequest,
): Promise<ProjectSourcesResult> {
  const startedAt = Date.now();
  const logger: BrowserLogger = ((message: string) => request.log?.(message)) as BrowserLogger;
  const projectUrl = normalizeProjectSourcesUrl(request.chatgptUrl);
  const operation = request.operation;
  const files = request.files ?? [];
  const plannedUploads = buildProjectSourcesUploadPlan(files);
  const warnings: string[] = [];
  if (operation === "add" && files.length === 0) {
    throw new Error("Project Sources add requires at least one file.");
  }
  if (request.dryRun) {
    return {
      status: "dry-run",
      operation,
      projectUrl,
      dryRun: true,
      plannedUploads,
      warnings,
      tookMs: Date.now() - startedAt,
    };
  }

  let config = resolveBrowserConfig({
    ...request.config,
    url: projectUrl,
    chatgptUrl: projectUrl,
  });
  if (config.remoteChrome) {
    throw new Error(
      "Project Sources v1 uses local browser automation only. Run it on the signed-in browser host.",
    );
  }

  const manualLogin = Boolean(config.manualLogin);
  const manualProfileDir = config.manualLoginProfileDir
    ? path.resolve(config.manualLoginProfileDir)
    : defaultManualLoginProfileDir();
  const userDataDir = manualLogin
    ? manualProfileDir
    : await mkdtemp(path.join(os.tmpdir(), "oracle-project-sources-"));
  const effectiveKeepBrowser = Boolean(config.keepBrowser);
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
    logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
    await assertManualLoginProfileReadyForRun({
      userDataDir,
      keepBrowser: effectiveKeepBrowser,
    });
  } else {
    logger(`Created temporary Chrome profile at ${userDataDir}`);
  }

  let chrome: BrowserChrome | null = null;
  let reusedChrome: LaunchedChrome | null = null;
  let client: ChromeClient | null = null;
  let isolatedTargetId: string | null = null;
  let removeTerminationHooks: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let connectionClosedUnexpectedly = false;
  let completed = false;

  try {
    const acquired = manualLogin
      ? await acquireManualLoginChromeForProjectSources(userDataDir, config, logger)
      : {
          chrome: await launchChrome({ ...config, remoteChrome: null }, userDataDir, logger),
          reusedChrome: null,
        };
    chrome = acquired.chrome;
    reusedChrome = acquired.reusedChrome;
    const chromeHost = chrome.host ?? "127.0.0.1";

    removeTerminationHooks = registerTerminationHooks(
      chrome,
      userDataDir,
      effectiveKeepBrowser,
      logger,
      {
        isInFlight: () => !completed,
        preserveUserDataDir: manualLogin,
      },
    );

    const strictTabIsolation = Boolean(manualLogin && reusedChrome);
    const devtoolsRetries = manualLogin ? 6 : 0;
    const connection = await connectWithNewTab(chrome.port, logger, "about:blank", chromeHost, {
      fallbackToDefault: !strictTabIsolation,
      retries: devtoolsRetries,
      retryDelayMs: 500,
    });
    client = connection.client;
    isolatedTargetId = connection.targetId ?? null;
    const disconnectPromise = new Promise<never>((_, reject) => {
      client?.on("disconnect", () => {
        connectionClosedUnexpectedly = true;
        reject(new Error("Chrome window closed before Project Sources finished."));
      });
    });
    const raceWithDisconnect = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([
        promise,
        disconnectPromise,
        ...(chrome?.resourceExhaustion ? [chrome.resourceExhaustion] : []),
      ]);

    const { Network, Page, Runtime, Input, DOM, Target } = client;
    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    if (!config.headless && config.hideWindow) {
      await positionChromeWindowOffscreen(client, logger);
    }
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);
    if (!manualLogin) {
      await Network.clearBrowserCookies();
    }

    const appliedCookies = await applyProjectSourcesCookies({
      config,
      network: Network,
      manualLogin,
      logger,
    });
    await clearStaleChatGptConversationCookies(Network, Target, logger);

    await raceWithDisconnect(navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger));
    await raceWithDisconnect(
      waitForProjectSourcesLogin({
        runtime: Runtime,
        logger,
        appliedCookies,
        manualLogin,
        timeoutMs: config.timeoutMs,
        profileDir: userDataDir,
        keepBrowser: effectiveKeepBrowser,
      }),
    );
    await raceWithDisconnect(navigateToChatGPT(Page, Runtime, projectUrl, logger));
    await raceWithDisconnect(openProjectSourcesTab(Runtime, Input, config.inputTimeoutMs, logger));
    await raceWithDisconnect(waitForProjectSourcesReady(Runtime, config.inputTimeoutMs, logger));

    const sourcesBefore = await raceWithDisconnect(
      waitForProjectSourcesListSettled(Runtime, config.inputTimeoutMs, logger),
    );
    let sourcesAfter = sourcesBefore;
    if (operation === "add") {
      sourcesAfter = await raceWithDisconnect(
        uploadProjectSources(
          { runtime: Runtime, dom: DOM, input: Input },
          files,
          logger,
          config.timeoutMs,
        ),
      );
    }
    const added = operation === "add" ? diffAddedProjectSources(sourcesBefore, sourcesAfter) : [];
    completed = true;
    return {
      status: "ok",
      operation,
      projectUrl,
      dryRun: false,
      sourcesBefore,
      sourcesAfter,
      plannedUploads,
      added,
      warnings,
      tookMs: Date.now() - startedAt,
    };
  } finally {
    removeDialogHandler?.();
    removeTerminationHooks?.();
    const chromeHost = chrome?.host ?? "127.0.0.1";
    try {
      await client?.close();
    } catch {
      // ignore close failures
    }
    if (completed && isolatedTargetId && chrome?.port) {
      await closeTab(chrome.port, isolatedTargetId, logger, chromeHost).catch(() => undefined);
    }
    chrome?.stopResourceWatchdog?.();

    let keepBrowserOpen = effectiveKeepBrowser;
    if (!keepBrowserOpen && reusedChrome && !connectionClosedUnexpectedly) {
      keepBrowserOpen = true;
      logger("[browser] Reused shared Chrome; leaving browser process running.");
    }
    if (!keepBrowserOpen && chrome) {
      if (!connectionClosedUnexpectedly) {
        try {
          await chrome.kill();
        } catch {
          // ignore kill failures
        }
      }
      if (manualLogin) {
        const shouldCleanup = await shouldCleanupManualLoginProfileState(
          userDataDir,
          logger.verbose ? logger : undefined,
          { connectionClosedUnexpectedly, host: chrome.host ?? "127.0.0.1" },
        );
        if (shouldCleanup) {
          await cleanupStaleProfileState(userDataDir, logger).catch(() => undefined);
        }
      } else {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } else if (chrome) {
      try {
        chrome.process?.unref();
      } catch {
        // best effort
      }
      logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
    }
  }
}

async function applyProjectSourcesCookies({
  config,
  network,
  manualLogin,
  logger,
}: {
  config: ResolvedBrowserConfig;
  network: ChromeClient["Network"];
  manualLogin: boolean;
  logger: BrowserLogger;
}): Promise<number> {
  const manualLoginCookieSync = manualLogin && Boolean(config.manualLoginCookieSync);
  const cookieSyncEnabled = config.cookieSync && (!manualLogin || manualLoginCookieSync);
  if (!cookieSyncEnabled) {
    logger(
      manualLogin
        ? "Skipping Chrome cookie sync (--browser-manual-login enabled); reuse the opened profile after signing in."
        : "Skipping Chrome cookie sync (--browser-no-cookie-sync)",
    );
    return 0;
  }
  const cookieCount = await syncCookies(network, config.url, config.chromeProfile, logger, {
    allowErrors: config.allowCookieErrors ?? false,
    filterNames: config.cookieNames ?? undefined,
    inlineCookies: config.inlineCookies ?? undefined,
    cookiePath: config.chromeCookiePath ?? undefined,
    waitMs: config.cookieSyncWaitMs ?? 0,
  });
  logger(
    cookieCount > 0
      ? config.inlineCookies
        ? `Applied ${cookieCount} inline cookies`
        : `Copied ${cookieCount} cookies from Chrome profile ${config.chromeProfile ?? "Default"}`
      : "No Chrome cookies found; continuing without session reuse",
  );
  return cookieCount;
}

async function waitForProjectSourcesLogin({
  runtime,
  logger,
  appliedCookies,
  manualLogin,
  timeoutMs,
  profileDir,
  keepBrowser,
}: {
  runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  appliedCookies: number;
  manualLogin: boolean;
  timeoutMs: number;
  profileDir?: string;
  keepBrowser?: boolean;
}): Promise<void> {
  if (!manualLogin) {
    await ensureLoggedIn(runtime, logger, { appliedCookies });
    return;
  }
  const waitMs = resolveManualLoginWaitMs(timeoutMs, Boolean(keepBrowser));
  const deadline = Date.now() + waitMs;
  let lastNotice = 0;
  while (Date.now() < deadline) {
    try {
      await ensureLoggedIn(runtime, logger, { appliedCookies });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        message.toLowerCase().includes("login button") ||
        message.toLowerCase().includes("session not detected");
      if (!retryable) {
        throw error;
      }
      const now = Date.now();
      if (now - lastNotice > 5000) {
        logger(
          "Manual login mode: please sign into chatgpt.com in the opened Chrome window; waiting for session to appear...",
        );
        lastNotice = now;
      }
      await delay(1000);
    }
  }
  const setupCommand = formatManualLoginSetupCommand(profileDir ?? defaultManualLoginProfileDir());
  throw new Error(
    "Manual login mode timed out waiting for ChatGPT session. " +
      `Browser mode is using Oracle's private Chrome profile at ${profileDir ?? "(default profile)"}, not your normal Chrome profile. ` +
      `Run first-time setup, sign in there, then retry: ${setupCommand}`,
  );
}

async function acquireManualLoginChromeForProjectSources(
  userDataDir: string,
  config: ResolvedBrowserConfig,
  logger: BrowserLogger,
): Promise<{ chrome: BrowserChrome; reusedChrome: LaunchedChrome | null }> {
  return await withProfileLaunchLock(
    userDataDir,
    config.profileLockTimeoutMs ?? 0,
    async () => {
      const reusedChrome = await maybeReuseProjectSourcesChrome(userDataDir, logger, {
        waitForPortMs: config.reuseChromeWaitMs,
      });
      const chrome = reusedChrome
        ? await monitorAdoptedLocalChrome(reusedChrome, config, userDataDir, logger)
        : await launchChrome(
            {
              ...config,
              remoteChrome: null,
            },
            userDataDir,
            logger,
          );
      if (chrome.port) {
        await writeDevToolsActivePort(userDataDir, chrome.port);
        if (!reusedChrome && chrome.pid) {
          await writeChromePid(userDataDir, chrome.pid);
        }
      }
      return { chrome, reusedChrome };
    },
    logger,
  );
}

async function maybeReuseProjectSourcesChrome(
  userDataDir: string,
  logger: BrowserLogger,
  options: { waitForPortMs?: number; probe?: typeof verifyDevToolsReachable } = {},
): Promise<LaunchedChrome | null> {
  const waitForPortMs = Math.max(0, options.waitForPortMs ?? 0);
  let port = await readDevToolsPort(userDataDir);
  if (!port && waitForPortMs > 0) {
    const deadline = Date.now() + waitForPortMs;
    logger(`Waiting up to ${Math.round(waitForPortMs / 1000)}s for shared Chrome to appear...`);
    while (!port && Date.now() < deadline) {
      await delay(250);
      port = await readDevToolsPort(userDataDir);
    }
  }
  let pid = await readChromePid(userDataDir);
  if (!port) {
    const discovered = await findRunningChromeDebugTargetForProfile(userDataDir);
    if (!discovered) {
      if (pid) {
        logger(
          `No reachable Chrome DevTools target found for ${userDataDir}; clearing stale profile state before launching new Chrome.`,
        );
        await cleanupStaleProfileState(userDataDir, logger, {
          lockRemovalMode: "if_oracle_pid_dead",
        });
      }
      return null;
    }
    const probe = await (options.probe ?? verifyDevToolsReachable)({ port: discovered.port });
    if (!probe.ok) {
      logger(
        `Discovered Chrome for ${userDataDir} on port ${discovered.port} but it was unreachable (${probe.error}); launching new Chrome.`,
      );
      await cleanupStaleProfileState(userDataDir, logger, {
        lockRemovalMode: "if_oracle_pid_dead",
      });
      return null;
    }
    await writeDevToolsActivePort(userDataDir, discovered.port);
    await writeChromePid(userDataDir, discovered.pid);
    port = discovered.port;
    pid = discovered.pid;
    logger(
      `Discovered running Chrome for ${userDataDir}; reusing (DevTools port ${port}, pid ${pid})`,
    );
    return { port, pid, kill: async () => {}, process: undefined } as unknown as LaunchedChrome;
  }
  const probe = await (options.probe ?? verifyDevToolsReachable)({ port });
  if (!probe.ok) {
    logger(
      `Recorded Chrome DevTools port ${port} is stale (${probe.error}); launching new Chrome.`,
    );
    await cleanupStaleProfileState(userDataDir, logger, {
      lockRemovalMode: "if_oracle_pid_dead",
    });
    return null;
  }
  logger(`Reusing running Chrome on port ${port} with profile ${userDataDir}`);
  return {
    port,
    pid: pid ?? undefined,
    kill: async () => {},
    process: undefined,
  } as unknown as LaunchedChrome;
}

export async function maybeReuseProjectSourcesChromeForTest(
  userDataDir: string,
  logger: BrowserLogger,
  options: { waitForPortMs?: number; probe?: typeof verifyDevToolsReachable } = {},
): Promise<LaunchedChrome | null> {
  return maybeReuseProjectSourcesChrome(userDataDir, logger, options);
}
