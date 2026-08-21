import { readFile, rm } from "node:fs/promises";
import {
  startOwnedChromeResourceWatchdog,
  terminateVerifiedOwnedChromeTree,
  type BrowserResourceWatchdogConfig,
} from "./resourceWatchdog.js";
import type { BrowserLogger } from "./types.js";

interface WorkerPayload {
  rootPid: number;
  profilePath: string;
  lockPath: string;
  lockToken: string;
  config?: BrowserResourceWatchdogConfig;
}

function readPayload(): WorkerPayload {
  const raw = process.argv[2];
  if (!raw) throw new Error("Detached resource watchdog payload is missing.");
  const payload = JSON.parse(raw) as Partial<WorkerPayload>;
  const rootPid = payload.rootPid;
  if (typeof rootPid !== "number" || !Number.isInteger(rootPid) || rootPid <= 0) {
    throw new Error("Detached resource watchdog root PID is invalid.");
  }
  if (typeof payload.profilePath !== "string" || !payload.profilePath.trim()) {
    throw new Error("Detached resource watchdog profile path is invalid.");
  }
  if (typeof payload.lockPath !== "string" || !payload.lockPath.trim()) {
    throw new Error("Detached resource watchdog lock path is invalid.");
  }
  if (typeof payload.lockToken !== "string" || !payload.lockToken.trim()) {
    throw new Error("Detached resource watchdog lock token is invalid.");
  }
  return payload as WorkerPayload;
}

function logger(): BrowserLogger {
  return Object.assign(
    (message: string) => {
      process.stderr.write(`[browser-resource-detached] ${message}\n`);
    },
    { verbose: false },
  );
}

async function removeOwnedLock(payload: WorkerPayload): Promise<void> {
  try {
    const current = JSON.parse(
      await readFile(`${payload.lockPath}/payload.json`, "utf8"),
    ) as Partial<WorkerPayload>;
    if (current.lockToken !== payload.lockToken) return;
  } catch {
    return;
  }
  await rm(payload.lockPath, { recursive: true, force: true }).catch(() => undefined);
}

async function run(): Promise<void> {
  const payload = readPayload();
  const log = logger();
  const keepAlive = setInterval(() => undefined, 60_000);
  let hardLimitInFlight = false;
  const stopped = (
    Promise as PromiseConstructor & {
      withResolvers<T>(): {
        promise: Promise<T>;
        resolve: (value: T | PromiseLike<T>) => void;
        reject: (reason?: unknown) => void;
      };
    }
  ).withResolvers<void>();

  try {
    const watchdog = await startOwnedChromeResourceWatchdog(
      {
        rootPid: payload.rootPid,
        profilePath: payload.profilePath,
        logger: log,
        config: payload.config,
        onStop: () => {
          if (!hardLimitInFlight) stopped.resolve();
        },
        onHardLimit: async (error, evidence) => {
          hardLimitInFlight = true;
          log(error.message);
          try {
            if (evidence) {
              const result = await terminateVerifiedOwnedChromeTree(evidence);
              if (!result.terminated) {
                log(
                  `Detached Chrome cleanup was incomplete (${result.reason}); remaining PIDs: ${result.remainingPids.join(",") || "unknown"}.`,
                );
              }
            }
          } catch (cleanupError) {
            log(
              `Detached Chrome cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}.`,
            );
          } finally {
            stopped.resolve();
          }
        },
      },
      {},
    );
    void watchdog.exhaustion.catch((error: unknown) => {
      log(error instanceof Error ? error.message : String(error));
    });
    await stopped.promise;
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    clearInterval(keepAlive);
    await removeOwnedLock(payload);
  }
}

void run();
