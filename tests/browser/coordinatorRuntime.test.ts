import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import {
  clearCoordinatorResourceObservation,
  CoordinatorRuntime,
  getCoordinatorRuntime,
  recordCoordinatorResourceObservation,
  resetCoordinatorRuntimeCache,
} from "../../src/browser/coordinatorRuntime.js";
import { BrowserCoordinatorStore } from "../../src/browser/coordinatorStore.js";
import type { ProcessTreeSample } from "../../src/browser/resourceTelemetry.js";
const runtimes: CoordinatorRuntime[] = [];
const stores: BrowserCoordinatorStore[] = [];
const dirs: string[] = [];

afterEach(async () => {
  resetCoordinatorRuntimeCache();
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function dbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-coordinator-runtime-"));
  dirs.push(dir);
  return path.join(dir, "coordinator.sqlite");
}

function open(databasePath: string, options: ConstructorParameters<typeof CoordinatorRuntime>[1]) {
  const runtime = new CoordinatorRuntime(
    { host: "127.0.0.1", port: 19222 },
    {
      databasePath,
      processProvider: { listProcesses: async () => [] },
      endpointProbe: async () => ({ ok: false }),
      ...options,
    },
  );
  runtimes.push(runtime);
  return runtime;
}

function resourceSample(rssBytes: number): ProcessTreeSample {
  return {
    sampledAt: "2026-08-10T00:00:00.000Z",
    sampledAtMs: 1_000,
    rootPid: 300,
    rootFound: true,
    targetCount: 1,
    targetTypes: { page: 1 },
    processCount: 1,
    processTypeCounts: { browser: 1 },
    rssBytes,
    workingSetBytes: rssBytes,
    cpuPercent: 1,
    cpuTimeMs: 10,
    processes: [],
  };
}

describe("CoordinatorRuntime", () => {
  test("claims one live owner and rejects a second process before admission", async () => {
    const databasePath = await dbPath();
    const first = open(databasePath, {
      ownerPid: 101,
      ownerStartToken: "first",
      targetCeilings: { total: 1 },
    });
    const second = open(databasePath, {
      ownerPid: 202,
      ownerStartToken: "second",
      targetCeilings: { total: 1 },
    });
    const lease = await first.reserve();
    await expect(second.reserve()).rejects.toMatchObject({
      category: "browser-automation",
      details: expect.objectContaining({ stage: "browser-coordinator", reason: "owner_active" }),
    });
    await lease.bind("observed-target");
    expect(first.store.listTargets()).toHaveLength(1);
  });

  test("binds a reservation without changing capacity and releases confirmed or lost targets", async () => {
    const databasePath = await dbPath();
    const runtime = open(databasePath, {
      ownerPid: 101,
      ownerStartToken: "first",
      targetCeilings: { total: 1 },
    });
    const lease = await runtime.reserve({ role: "mutation" });
    await lease.bind("target-1");
    expect(runtime.store.listTargets()[0]).toMatchObject({ targetId: "target-1", state: "active" });
    await lease.release({ confirmed: true });
    expect(runtime.reservationCount).toBe(0);

    const replacement = open(databasePath, {
      ownerPid: 202,
      ownerStartToken: "second",
      targetCeilings: { total: 1 },
    });
    const next = await replacement.reserve();
    await next.markLost();
    expect(replacement.reservationCount).toBe(0);
  });

  test("keeps a lease retryable when durable release fails", async () => {
    const databasePath = await dbPath();
    const runtime = open(databasePath, {
      ownerPid: 101,
      ownerStartToken: "release-retry",
      targetCeilings: { total: 1 },
    });
    const lease = await runtime.reserve();
    const updateTarget = runtime.store.updateTarget.bind(runtime.store);
    const updateSpy = vi
      .spyOn(runtime.store, "updateTarget")
      .mockImplementationOnce(() => {
        throw new Error("transient database failure");
      })
      .mockImplementation(updateTarget);

    await expect(lease.markLost()).rejects.toThrow("transient database failure");
    expect(runtime.reservationCount).toBe(1);
    expect(runtime.store.listTargets()).toMatchObject([{ state: "admitted" }]);

    await lease.markLost();
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(runtime.reservationCount).toBe(0);
    const verifier = new BrowserCoordinatorStore({
      profileId: "127.0.0.1:19222",
      databasePath,
    });
    stores.push(verifier);
    expect(verifier.listTargets()).toMatchObject([{ state: "lost" }]);
  });

  test("takes over a stale controller generation", async () => {
    const databasePath = await dbPath();
    const first = open(databasePath, {
      ownerPid: 101,
      ownerStartToken: "first",
      staleOwnerMs: 100,
      now: () => 1_000,
    });
    await first.reserve();
    const second = open(databasePath, {
      ownerPid: 202,
      ownerStartToken: "second",
      staleOwnerMs: 100,
      now: () => 1_200,
    });
    const next = await second.reserve();
    expect(next.generation).toBe(2);
    await next.markLost();
  });

  test("returns a typed hard-ceiling error without admitting another target", async () => {
    const databasePath = await dbPath();
    const runtime = open(databasePath, {
      ownerPid: 101,
      ownerStartToken: "first",
      targetCeilings: { total: 1 },
    });
    const first = await runtime.reserve();
    await expect(runtime.reserve()).rejects.toBeInstanceOf(BrowserAutomationError);
    await first.release();
  });

  test("persists watchdog telemetry and pauses admission until hysteresis recovery", async () => {
    const databasePath = await dbPath();
    const endpoint = { host: "127.0.0.1", port: 19223 };
    const options = {
      databasePath,
      ownerPid: 101,
      ownerStartToken: "first",
      targetCeilings: { total: 3, roles: { mutation: 2, recovery: 1 } },
    };
    const runtime = getCoordinatorRuntime(endpoint, options);
    const first = await runtime.reserve({ role: "mutation" });
    const thresholds = {
      rssResumeBytes: 100,
      rssSoftBytes: 200,
      rssHardBytes: 300,
    };

    expect(
      recordCoordinatorResourceObservation(
        endpoint,
        resourceSample(225),
        { phase: "soft", reason: "rss_soft_watermark", ...thresholds },
        options,
      ),
    ).toBe(true);
    await expect(runtime.reserve({ role: "mutation" })).rejects.toMatchObject({
      details: {
        reason: "resource_soft",
        code: "resource-admission-paused",
      },
    });
    const recovery = await runtime.reserve({ role: "recovery" });
    await recovery.release();

    recordCoordinatorResourceObservation(
      endpoint,
      resourceSample(90),
      { phase: "normal", reason: "below_limits", ...thresholds },
      options,
    );
    const resumed = await runtime.reserve({ role: "mutation" });
    expect(runtime.store.listResourceSamples()).toHaveLength(2);
    expect(runtime.store.getResourceGate()).toMatchObject({
      phase: "normal",
      processTreeRssBytes: 90,
    });

    clearCoordinatorResourceObservation(endpoint, options);
    expect(runtime.store.getResourceGate()).toMatchObject({
      phase: "normal",
      reason: "browser_stopped",
      processTreeRssBytes: 0,
    });
    await resumed.release();
    await first.release();
  });
  test("closes repeatedly and leaves a CAS-released target idempotently closed", async () => {
    const databasePath = await dbPath();
    const runtime = open(databasePath, {
      ownerPid: 101,
      ownerStartToken: "first",
      targetCeilings: { total: 1 },
    });
    const lease = await runtime.reserve();
    await lease.bind("target-close");
    await lease.release({ confirmed: true });
    await lease.release({ confirmed: false });
    await lease.markLost();
    runtime.close();
    runtime.close();
    expect(runtime.reservationCount).toBe(0);

    const verifier = new BrowserCoordinatorStore({
      profileId: "127.0.0.1:19222",
      databasePath,
      now: () => 2_000,
    });
    stores.push(verifier);
    expect(verifier.listTargets()).toMatchObject([{ targetId: "target-close", state: "closed" }]);
    expect(
      verifier.releaseProfile({ ownerPid: 101, ownerStartToken: "first", generation: 1 }),
    ).toBe(false);
    expect(
      verifier.releaseProfile({ ownerPid: 101, ownerStartToken: "first", generation: 1 }),
    ).toBe(false);
  });

  test("shutdown marks active leases lost before releasing the profile", async () => {
    const databasePath = await dbPath();
    const runtime = open(databasePath, {
      ownerPid: 101,
      ownerStartToken: "first",
      targetCeilings: { total: 1 },
    });
    const lease = await runtime.reserve();
    await lease.bind("target-shutdown");
    runtime.shutdown();
    runtime.shutdown();

    const verifier = new BrowserCoordinatorStore({
      profileId: "127.0.0.1:19222",
      databasePath,
      now: () => 2_000,
    });
    stores.push(verifier);
    expect(verifier.getProfile()).toMatchObject({
      state: "stopped",
      ownerPid: null,
      browserPid: null,
      heartbeatAt: null,
    });
    expect(verifier.listTargets()).toMatchObject([{ targetId: "target-shutdown", state: "lost" }]);
  });
});
