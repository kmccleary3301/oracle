import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type ProfileStateLogger = (message: string) => void;

const DEVTOOLS_ACTIVE_PORT_FILENAME = "DevToolsActivePort";
const DEVTOOLS_ACTIVE_PORT_RELATIVE_PATHS = [
  DEVTOOLS_ACTIVE_PORT_FILENAME,
  path.join("Default", DEVTOOLS_ACTIVE_PORT_FILENAME),
] as const;

const CHROME_PID_FILENAME = "chrome.pid";
const profileLaunchLocks = new Map<string, Promise<void>>();

export async function withProfileLaunchLock<T>(
  userDataDir: string,
  timeoutMs: number,
  callback: () => Promise<T>,
  logger?: ProfileStateLogger,
): Promise<T> {
  const key = path.resolve(userDataDir);
  const prior = profileLaunchLocks.get(key);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  profileLaunchLocks.set(key, gate);
  if (prior) {
    const timeout = Math.max(1, timeoutMs);
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        prior,
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`Timed out waiting for manual-login profile lock after ${timeout}ms`),
              ),
            timeout,
          );
        }),
      ]);
    } catch (error) {
      release();
      if (profileLaunchLocks.get(key) === gate) profileLaunchLocks.delete(key);
      throw error;
    } finally {
      clearTimeout(timer!);
    }
    logger?.(`Acquired manual-login profile launch lock for ${key}`);
  }
  try {
    return await callback();
  } finally {
    release();
    if (profileLaunchLocks.get(key) === gate) profileLaunchLocks.delete(key);
  }
}
const execFileAsync = promisify(execFile);

export function getDevToolsActivePortPaths(userDataDir: string): string[] {
  return DEVTOOLS_ACTIVE_PORT_RELATIVE_PATHS.map((relative) => path.join(userDataDir, relative));
}

export async function readDevToolsPort(userDataDir: string): Promise<number | null> {
  for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
    try {
      const raw = await readFile(candidate, "utf8");
      const firstLine = raw.split(/\r?\n/u)[0]?.trim();
      const port = Number.parseInt(firstLine ?? "", 10);
      if (Number.isFinite(port)) {
        return port;
      }
    } catch {
      // ignore missing/unreadable candidates
    }
  }
  return null;
}

export async function writeDevToolsActivePort(userDataDir: string, port: number): Promise<void> {
  const contents = `${port}\n/devtools/browser`;
  for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
    try {
      await mkdir(path.dirname(candidate), { recursive: true });
      await writeFile(candidate, contents, "utf8");
    } catch {
      // best effort
    }
  }
}

export async function readChromePid(userDataDir: string): Promise<number | null> {
  const pidPath = path.join(userDataDir, CHROME_PID_FILENAME);
  try {
    const raw = (await readFile(pidPath, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

export async function writeChromePid(userDataDir: string, pid: number): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) return;
  const pidPath = path.join(userDataDir, CHROME_PID_FILENAME);
  try {
    await mkdir(path.dirname(pidPath), { recursive: true });
    await writeFile(pidPath, `${Math.trunc(pid)}\n`, "utf8");
  } catch {
    // best effort
  }
}

export interface RunningChromeDebugTarget {
  pid: number;
  port: number;
}

export async function findRunningChromeDebugTargetForProfile(
  userDataDir: string,
): Promise<RunningChromeDebugTarget | null> {
  if (process.platform === "win32") {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pid=", "-o", "command="], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return findChromeDebugTargetForProfileFromProcessList(String(stdout ?? ""), userDataDir);
  } catch {
    return null;
  }
}

function findChromeDebugTargetForProfileFromProcessList(
  processList: string,
  userDataDir: string,
): RunningChromeDebugTarget | null {
  for (const line of processList.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    const command = match[2] ?? "";
    const lower = command.toLowerCase();
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!lower.includes("chrome") && !lower.includes("chromium")) continue;
    if (!lower.includes("user-data-dir") || !command.includes(userDataDir)) continue;
    const portMatch = command.match(/--remote-debugging-port(?:=|\s+)(\d+)/);
    const port = Number.parseInt(portMatch?.[1] ?? "", 10);
    if (!Number.isFinite(port) || port <= 0) continue;
    return { pid, port };
  }
  return null;
}

export function findChromeDebugTargetForProfileFromProcessListForTest(
  processList: string,

  userDataDir: string,
): RunningChromeDebugTarget | null {
  return findChromeDebugTargetForProfileFromProcessList(processList, userDataDir);
}

function isChromeCommandForUserDataDir(command: string | null, userDataDir: string): boolean {
  if (!command) return false;
  const lower = command.toLowerCase();
  return (
    (lower.includes("chrome") || lower.includes("chromium")) &&
    lower.includes("user-data-dir") &&
    command.includes(userDataDir)
  );
}

export function isChromeCommandForUserDataDirForTest(
  command: string | null,
  userDataDir: string,
): boolean {
  return isChromeCommandForUserDataDir(command, userDataDir);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "EPERM",
    );
  }
}

async function isChromeUsingUserDataDir(userDataDir: string): Promise<boolean> {
  if (process.platform === "win32") return false;
  try {
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "command="], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return String(stdout ?? "")
      .split("\n")
      .some((line) => {
        const lower = line.toLowerCase();
        return (
          (lower.includes("chrome") || lower.includes("chromium")) &&
          lower.includes("user-data-dir") &&
          line.includes(userDataDir)
        );
      });
  } catch {
    return false;
  }
}
export async function verifyDevToolsReachable({
  port,
  host = "127.0.0.1",
  attempts = 3,
  timeoutMs = 3000,
}: {
  port: number;
  host?: string;
  attempts?: number;
  timeoutMs?: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const versionUrl = `http://${host}:${port}/json/version`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(versionUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return { ok: true };
    } catch (error) {
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }
  return { ok: false, error: "unreachable" };
}

export async function shouldCleanupManualLoginProfileState(
  userDataDir: string,
  logger?: ProfileStateLogger,
  options: {
    connectionClosedUnexpectedly?: boolean;
    host?: string;
    probe?: typeof verifyDevToolsReachable;
  } = {},
): Promise<boolean> {
  const port = await readDevToolsPort(userDataDir);
  if (!port) {
    return true;
  }
  const probe = await (options.probe ?? verifyDevToolsReachable)({ port, host: options.host });
  if (probe.ok) {
    logger?.(`DevTools port ${port} still reachable; preserving manual-login profile state`);
    return false;
  }
  logger?.(`DevTools port ${port} unreachable (${probe.error}); clearing stale profile state`);
  return true;
}

export async function cleanupStaleProfileState(
  userDataDir: string,
  logger?: ProfileStateLogger,
  options: { lockRemovalMode?: "never" | "if_oracle_pid_dead" } = {},
): Promise<void> {
  for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
    try {
      await rm(candidate, { force: true });
      logger?.(`Removed stale DevToolsActivePort: ${candidate}`);
    } catch {
      // ignore cleanup errors
    }
  }
  if (options.lockRemovalMode !== "if_oracle_pid_dead") return;
  const pid = await readChromePid(userDataDir);
  if (!pid) return;
  if (isProcessAlive(pid)) {
    logger?.(`Chrome pid ${pid} still alive; skipping profile lock cleanup`);
    return;
  }
  if (await isChromeUsingUserDataDir(userDataDir)) {
    logger?.("Detected running Chrome using this profile; skipping profile lock cleanup");
    return;
  }
  for (const lock of ["lockfile", "SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    await rm(path.join(userDataDir, lock), { force: true }).catch(() => undefined);
  }
  logger?.("Cleaned up stale Chrome profile locks");
}
