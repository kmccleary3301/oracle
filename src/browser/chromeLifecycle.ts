import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import CDP from "chrome-remote-interface";
import { launch, Launcher, type LaunchedChrome } from "chrome-launcher";
import type { BrowserLogger, ResolvedBrowserConfig, ChromeClient } from "./types.js";
import { cleanupStaleProfileState } from "./profileState.js";
import { delay } from "./utils.js";
import {
  closeRemoteChromePageTarget,
  DEFAULT_REMOTE_CHROME_MAX_TABS,
  forgetRemoteChromeTarget,
  pruneRemoteChromeTargets,
  recordRemoteChromeTarget,
} from "./remoteChromeTabs.js";

const execFileAsync = promisify(execFile);

export async function launchChrome(
  config: ResolvedBrowserConfig,
  userDataDir: string,
  logger: BrowserLogger,
) {
  const connectHost = resolveRemoteDebugHost();
  const debugBindAddress = connectHost && connectHost !== "127.0.0.1" ? "0.0.0.0" : connectHost;
  const debugPort = config.debugPort ?? parseDebugPortEnv();
  const chromeFlags = buildChromeFlags(config.headless ?? false, debugBindAddress);
  const usePatchedLauncher = Boolean(connectHost && connectHost !== "127.0.0.1");
  const launcher = usePatchedLauncher
    ? await launchWithCustomHost({
        chromeFlags,
        chromePath: config.chromePath ?? undefined,
        userDataDir,
        host: connectHost ?? "127.0.0.1",
        requestedPort: debugPort ?? undefined,
        logger,
      })
    : await launch({
        chromePath: config.chromePath ?? undefined,
        chromeFlags,
        userDataDir,
        handleSIGINT: false,
        port: debugPort ?? undefined,
      });
  const pidLabel = typeof launcher.pid === "number" ? ` (pid ${launcher.pid})` : "";
  const hostLabel = connectHost ? ` on ${connectHost}` : "";
  logger(`Launched Chrome${pidLabel} on port ${launcher.port}${hostLabel}`);
  return Object.assign(launcher, { host: connectHost ?? "127.0.0.1" }) as LaunchedChrome & {
    host?: string;
  };
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
    const leaveRunning = keepBrowser || inFlight;
    if (leaveRunning) {
      logger(
        `Received ${signal}; leaving Chrome running${inFlight ? " (assistant response pending)" : ""}`,
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

export async function hideChromeWindow(
  chrome: LaunchedChrome,
  logger: BrowserLogger,
): Promise<void> {
  if (process.platform !== "darwin") {
    logger("Window hiding is only supported on macOS");
    return;
  }
  if (!chrome.pid) {
    logger("Unable to hide window: missing Chrome PID");
    return;
  }
  const script = `tell application "System Events"
    try
      set visible of (first process whose unix id is ${chrome.pid}) to false
    end try
  end tell`;
  try {
    await execFileAsync("osascript", ["-e", script]);
    logger("Chrome window hidden (Cmd-H)");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to hide Chrome window: ${message}`);
  }
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
  options?: { maxTabs?: number },
): Promise<RemoteChromeConnection> {
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
      return { client: targetConnection.client, targetId: targetConnection.targetId };
    }
  }
  const fallbackClient = await CDP({ host, port });
  logger(`Connected to remote Chrome DevTools protocol at ${host}:${port}`);
  return { client: fallbackClient };
}

export async function closeRemoteChromeTarget(
  host: string,
  port: number,
  targetId: string | undefined,
  logger: BrowserLogger,
): Promise<void> {
  if (!targetId) {
    return;
  }
  try {
    await closeRemoteChromePageTarget(host, port, targetId);
    if (logger.verbose) {
      logger(`Closed remote Chrome tab ${targetId}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to close remote Chrome tab ${targetId}: ${message}`);
  } finally {
    await forgetRemoteChromeTarget(host, port, targetId).catch(() => undefined);
  }
}

export interface RemoteChromeConnection {
  client: ChromeClient;
  targetId?: string;
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

async function connectToNewTarget(
  host: string,
  port: number,
  url: string,
  logger: BrowserLogger,
  messages: TargetConnectMessages,
): Promise<{ client: ChromeClient; targetId: string } | null> {
  try {
    const target = await CDP.New({ host, port, url });
    try {
      const client = await CDP({ host, port, target: target.id });
      if (messages.opened) {
        logger(messages.opened(target.id));
      }
      return { client, targetId: target.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(messages.attachFailed(target.id, message));
      try {
        await CDP.Close({ host, port, id: target.id });
      } catch (closeError) {
        const closeMessage = closeError instanceof Error ? closeError.message : String(closeError);
        logger(messages.closeFailed(target.id, closeMessage));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(messages.openFailed(message));
  }
  return null;
}

export async function connectWithNewTab(
  port: number,
  logger: BrowserLogger,
  initialUrl?: string,
  host?: string,
  options?: { fallbackToDefault?: boolean; retries?: number; retryDelayMs?: number },
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
): Promise<void> {
  const effectiveHost = host ?? "127.0.0.1";
  try {
    await CDP.Close({ host: effectiveHost, port, id: targetId });
    logger(`Closed isolated browser tab (target=${targetId})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Failed to close browser tab ${targetId}: ${message}`);
  }
}

function buildChromeFlags(headless: boolean, debugBindAddress?: string | null): string[] {
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
  }

  return flags;
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

function resolveRemoteDebugHost(): string | null {
  const override =
    process.env.ORACLE_BROWSER_REMOTE_DEBUG_HOST?.trim() || process.env.WSL_HOST_IP?.trim();
  if (override) {
    return override;
  }
  if (!isWsl()) {
    return null;
  }
  try {
    const resolv = readFileSync("/etc/resolv.conf", "utf8");
    for (const line of resolv.split("\n")) {
      const match = line.match(/^nameserver\s+([0-9.]+)/);
      if (match?.[1]) {
        return match[1];
      }
    }
  } catch {
    // ignore; fall back to localhost
  }
  return null;
}

function isWsl(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  if (process.env.WSL_DISTRO_NAME) {
    return true;
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
  logger,
}: {
  chromeFlags: string[];
  chromePath?: string | null;
  userDataDir: string;
  host: string | null;
  requestedPort?: number;
  logger: BrowserLogger;
}): Promise<LaunchedChrome & { host?: string }> {
  const launcher = new Launcher({
    chromePath: chromePath ?? undefined,
    chromeFlags,
    userDataDir,
    handleSIGINT: false,
    port: requestedPort ?? undefined,
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
