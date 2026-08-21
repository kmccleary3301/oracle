import path from "node:path";
import os from "node:os";
import { mkdir } from "node:fs/promises";
import type { BrowserRunOptions, BrowserLogger, ChromeClient } from "../browser/types.js";
import {
  launchChrome,
  connectWithNewTab,
  closeTab,
  monitorLocalChromeProcess,
  type LocalChromeResourceMonitor,
} from "../browser/chromeLifecycle.js";
import { resolveBrowserConfig } from "../browser/config.js";
import {
  readChromePid,
  readDevToolsPort,
  writeDevToolsActivePort,
  writeChromePid,
  cleanupStaleProfileState,
  verifyDevToolsReachable,
} from "../browser/profileState.js";

export interface GeminiBrowserSession {
  profileDir: string;
  port: number;
  client: ChromeClient;
  targetId?: string;
  close: () => Promise<void>;
  raceWithResourceLimit: <T>(promise: Promise<T>) => Promise<T>;
}

export interface OpenGeminiBrowserSessionInput {
  browserConfig: BrowserRunOptions["config"];
  keepBrowserDefault: boolean;
  purpose: string;
  log?: BrowserLogger;
}

export async function openGeminiBrowserSession(
  input: OpenGeminiBrowserSessionInput,
): Promise<GeminiBrowserSession> {
  const { browserConfig, keepBrowserDefault, purpose, log } = input;
  const resolvedConfig = resolveBrowserConfig({
    ...browserConfig,
    manualLogin: true,
    keepBrowser: browserConfig?.keepBrowser ?? keepBrowserDefault,
  });
  const profileDir =
    resolvedConfig.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile");
  await mkdir(profileDir, { recursive: true });
  const keepBrowser = Boolean(resolvedConfig.keepBrowser);

  let port = await readDevToolsPort(profileDir);
  let launchedChrome: Awaited<ReturnType<typeof launchChrome>> | null = null;
  let chromeWasLaunched = false;
  let resourceMonitor: LocalChromeResourceMonitor | undefined;

  if (port) {
    const probe = await verifyDevToolsReachable({ port });
    if (!probe.ok) {
      log?.(`[gemini-web] Stale DevTools port ${port}; launching fresh Chrome for ${purpose}.`);
      await cleanupStaleProfileState(profileDir, log, { lockRemovalMode: "if_oracle_pid_dead" });
      port = null;
    }
  }

  if (!port) {
    log?.(`[gemini-web] Launching Chrome for ${purpose}.`);
    launchedChrome = await launchChrome(resolvedConfig, profileDir, log ?? (() => {}));
    port = launchedChrome.port;
    chromeWasLaunched = true;
    await writeDevToolsActivePort(profileDir, port);
    if (launchedChrome.pid) {
      await writeChromePid(profileDir, launchedChrome.pid);
    }
    if (launchedChrome.resourceExhaustion && launchedChrome.stopResourceWatchdog) {
      resourceMonitor = {
        resourceExhaustion: launchedChrome.resourceExhaustion,
        stopResourceWatchdog: launchedChrome.stopResourceWatchdog,
      };
    }
  } else {
    log?.(`[gemini-web] Reusing Chrome on port ${port} for ${purpose}.`);
    const pid = await readChromePid(profileDir);
    if (!pid) {
      throw new Error(
        `Oracle refused to reuse Chrome on port ${port} because its root PID is unavailable for memory monitoring.`,
      );
    }
    resourceMonitor = await monitorLocalChromeProcess({
      port,
      pid,
      profileDir,
      config: resolvedConfig,
      logger: log ?? (() => {}),
    });
  }

  let connection: Awaited<ReturnType<typeof connectWithNewTab>>;
  try {
    connection = await (resourceMonitor
      ? Promise.race([
          connectWithNewTab(port, log ?? (() => {}), undefined),
          resourceMonitor.resourceExhaustion,
        ])
      : connectWithNewTab(port, log ?? (() => {}), undefined));
  } catch (error) {
    resourceMonitor?.stopResourceWatchdog();
    if (chromeWasLaunched && launchedChrome) {
      await launchedChrome.kill();
    }
    throw error;
  }
  const client = connection.client;
  const targetId = connection.targetId;

  const close = async (): Promise<void> => {
    resourceMonitor?.stopResourceWatchdog();
    if (keepBrowser) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      return;
    }

    if (targetId && port) {
      await closeTab(port, targetId, log ?? (() => {})).catch(() => undefined);
    }
    try {
      await client.close();
    } catch {
      /* ignore */
    }

    if (chromeWasLaunched && launchedChrome) {
      try {
        launchedChrome.kill();
      } catch {
        /* ignore */
      }
      await cleanupStaleProfileState(profileDir, log, { lockRemovalMode: "never" }).catch(
        () => undefined,
      );
    }
  };
  const raceWithResourceLimit = <T>(promise: Promise<T>): Promise<T> =>
    resourceMonitor ? Promise.race([promise, resourceMonitor.resourceExhaustion]) : promise;

  return {
    profileDir,
    port,
    client,
    targetId: targetId ?? undefined,
    close,
    raceWithResourceLimit,
  };
}
