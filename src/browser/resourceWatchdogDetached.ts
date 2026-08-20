import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserResourceWatchdogConfig } from "./resourceWatchdog.js";
import type { BrowserLogger } from "./types.js";

interface DetachedWatchdogPayload {
  rootPid: number;
  ownerPid: number;
  profilePath: string;
  lockPath: string;
  lockToken: string;
  config?: BrowserResourceWatchdogConfig;
}

export interface DetachedBrowserResourceWatchdogOptions {
  rootPid: number;
  profilePath: string;
  logger: BrowserLogger;
  config?: BrowserResourceWatchdogConfig;
}

export interface DetachedBrowserResourceWatchdog {
  readonly pid: number;
  readonly lockPath: string;
  readonly owned: boolean;
  stop(): Promise<void>;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function removeLockIfOwned(lockPath: string, lockToken: string): Promise<void> {
  const payload = await readJsonFile<Partial<DetachedWatchdogPayload>>(
    path.join(lockPath, "payload.json"),
  );
  if (payload?.lockToken === lockToken) {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function removeStaleLock(
  lockPath: string,
  rootPid: number,
): Promise<DetachedBrowserResourceWatchdog | null> {
  const payload = await readJsonFile<Partial<DetachedWatchdogPayload>>(
    path.join(lockPath, "payload.json"),
  );
  if (!payload) {
    await rm(lockPath, { recursive: true, force: true });
    return null;
  }
  const existingRootPid = payload.rootPid;
  const existingRootPidValue =
    typeof existingRootPid === "number" && Number.isInteger(existingRootPid) && existingRootPid > 0
      ? existingRootPid
      : null;
  const existingLockToken = payload.lockToken;
  const existingOwnerPid = payload.ownerPid;
  const existingOwnerAlive =
    typeof existingOwnerPid === "number" &&
    existingOwnerPid > 0 &&
    isProcessAlive(existingOwnerPid);
  const watchdogPid = Number.parseInt(
    await readFile(path.join(lockPath, "pid"), "utf8").catch(() => ""),
    10,
  );
  const watchdogPidValue = Number.isInteger(watchdogPid) && watchdogPid > 0 ? watchdogPid : null;
  const rootAlive = existingRootPidValue !== null && isProcessAlive(existingRootPidValue);
  const watchdogAlive = watchdogPidValue !== null && isProcessAlive(watchdogPidValue);
  if (rootAlive && existingLockToken && !watchdogPidValue && existingOwnerAlive) {
    throw new Error(`A resource watchdog is already starting for ${payload.profilePath}.`);
  }
  if (rootAlive && watchdogAlive && existingLockToken) {
    if (existingRootPidValue !== rootPid) {
      throw new Error(`A resource watchdog is already active for ${payload.profilePath}.`);
    }
    return {
      pid: watchdogPidValue,
      lockPath,
      owned: false,
      stop: async () => undefined,
    };
  }
  if (watchdogAlive && watchdogPidValue !== null) {
    try {
      process.kill(watchdogPidValue, "SIGTERM");
    } catch {
      // The process may have exited between the liveness check and the signal.
    }
  }
  await rm(lockPath, { recursive: true, force: true });
  return null;
}

async function resolveWorkerPath(): Promise<string> {
  const javascriptPath = fileURLToPath(new URL("./resourceWatchdogWorker.js", import.meta.url));
  try {
    await access(javascriptPath);
    return javascriptPath;
  } catch {
    return fileURLToPath(new URL("./resourceWatchdogWorker.ts", import.meta.url));
  }
}
function runtimeLoaderArguments(): string[] {
  const evaluationIndex = process.execArgv.findIndex(
    (argument) =>
      argument === "--eval" ||
      argument === "-e" ||
      argument === "--print" ||
      argument === "-p" ||
      argument.startsWith("--eval=") ||
      argument.startsWith("--print="),
  );
  return evaluationIndex < 0 ? [...process.execArgv] : process.execArgv.slice(0, evaluationIndex);
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  const resolvers = (
    Promise as PromiseConstructor & {
      withResolvers<T>(): {
        promise: Promise<T>;
        resolve: (value?: T | PromiseLike<T>) => void;
        reject: (reason?: unknown) => void;
      };
    }
  ).withResolvers<void>();
  const onSpawn = () => {
    child.off("error", onError);
    resolvers.resolve();
  };
  const onError = (error: Error) => {
    child.off("spawn", onSpawn);
    resolvers.reject(error);
  };
  child.once("spawn", onSpawn);
  child.once("error", onError);
  return resolvers.promise;
}

function detachedWatchdogEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.RUNNER_TRACKING_ID;
  return env;
}

export async function startDetachedBrowserResourceWatchdog(
  options: DetachedBrowserResourceWatchdogOptions,
): Promise<DetachedBrowserResourceWatchdog> {
  if (!Number.isInteger(options.rootPid) || options.rootPid <= 0) {
    throw new Error("Detached resource watchdog root PID is invalid.");
  }
  const lockPath = path.join(
    path.dirname(options.profilePath),
    `.${path.basename(options.profilePath)}.resource-watchdog`,
  );
  const existing = await readJsonFile<Partial<DetachedWatchdogPayload>>(
    path.join(lockPath, "payload.json"),
  );
  if (existing) {
    const active = await removeStaleLock(lockPath, options.rootPid);
    if (active) return active;
  } else {
    let lockExists = true;
    try {
      await access(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        lockExists = false;
      } else {
        throw error;
      }
    }
    if (lockExists) {
      const owner = await readJsonFile<{ pid?: number }>(path.join(lockPath, "owner.json"));
      if (owner?.pid && isProcessAlive(owner.pid)) {
        throw new Error(`A resource watchdog is already active for ${options.profilePath}.`);
      }
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  const lockToken = randomUUID();
  await mkdir(lockPath, { recursive: false }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`A resource watchdog is already active for ${options.profilePath}.`);
    }
    throw error;
  });
  const payload: DetachedWatchdogPayload = {
    rootPid: options.rootPid,
    ownerPid: process.pid,
    profilePath: options.profilePath,
    lockPath,
    lockToken,
    config: options.config,
  };
  try {
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ pid: process.pid }),
      "utf8",
    );
    await writeFile(path.join(lockPath, "payload.json"), JSON.stringify(payload), "utf8");
    const workerPath = await resolveWorkerPath();
    const workerArgs = workerPath.endsWith(".ts")
      ? [...runtimeLoaderArguments(), workerPath, JSON.stringify(payload)]
      : [workerPath, JSON.stringify(payload)];
    const child = spawn(process.execPath, workerArgs, {
      detached: true,
      stdio: "ignore",
      env: detachedWatchdogEnvironment(),
    });
    await waitForSpawn(child);
    child.unref();
    await writeFile(path.join(lockPath, "pid"), String(child.pid ?? ""), "utf8");
    options.logger(`Detached browser resource watchdog started (pid ${child.pid ?? "unknown"}).`);
    return {
      pid: child.pid ?? -1,
      lockPath,
      owned: true,
      async stop() {
        if (child.exitCode === null && child.signalCode === null && child.pid) {
          try {
            process.kill(child.pid, "SIGTERM");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
        await removeLockIfOwned(lockPath, lockToken);
      },
    };
  } catch (error) {
    await removeLockIfOwned(lockPath, lockToken);
    throw error;
  }
}
