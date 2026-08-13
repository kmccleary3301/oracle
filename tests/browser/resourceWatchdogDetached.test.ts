import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { startDetachedBrowserResourceWatchdog } from "../../src/browser/resourceWatchdogDetached.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  spawnMock.mockReset();
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function fakeChild(pid: number): ChildProcess & { unref: () => void } {
  const child = new EventEmitter() as ChildProcess & { unref: () => void };
  Object.assign(child, {
    pid,
    exitCode: null,
    signalCode: null,
    unref: vi.fn(),
  });
  return child;
}

function mockSpawnedChild(pid: number): ChildProcess & { unref: () => void } {
  const child = fakeChild(pid);
  spawnMock.mockImplementationOnce(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  return child;
}

function markChildExited(child: ChildProcess): void {
  Object.defineProperty(child, "exitCode", { configurable: true, value: 0, writable: true });
}

async function makeProfilePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-detached-watchdog-test-"));
  tempDirectories.push(directory);
  return path.join(directory, "profile");
}

describe("detached browser resource watchdog", () => {
  test("starts a source worker without inheriting an eval entrypoint and releases its lock", async () => {
    const child = mockSpawnedChild(process.pid);
    const profilePath = await makeProfilePath();

    const monitor = await startDetachedBrowserResourceWatchdog({
      rootPid: process.pid,
      profilePath,
      logger: vi.fn<(message: string) => void>(),
    });

    expect(monitor.owned).toBe(true);
    const [executable, args] = spawnMock.mock.calls[0] as [string, string[], object];
    expect(executable).toBe(process.execPath);
    expect(args.at(-2)).toMatch(/resourceWatchdogWorker\.ts$/);
    expect(JSON.parse(args.at(-1)!)).toMatchObject({ rootPid: process.pid, profilePath });

    markChildExited(child);
    await monitor.stop();
    await expect(stat(monitor.lockPath)).rejects.toThrow();
  });

  test("shares an active watcher for the same Chrome root instead of spawning a duplicate", async () => {
    const child = mockSpawnedChild(process.pid);
    const profilePath = await makeProfilePath();
    const options = {
      rootPid: process.pid,
      profilePath,
      logger: vi.fn<(message: string) => void>(),
    };

    const first = await startDetachedBrowserResourceWatchdog(options);
    const second = await startDetachedBrowserResourceWatchdog(options);

    expect(second).toMatchObject({ owned: false, pid: process.pid, lockPath: first.lockPath });
    expect(spawnMock).toHaveBeenCalledTimes(1);

    markChildExited(child);
    await first.stop();
    await second.stop();
  });
});
