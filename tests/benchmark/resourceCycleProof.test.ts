import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  AdaptivePollingScheduler,
  type ScheduledAdaptivePollJob,
} from "../../src/jobs/adaptivePolling.js";
import {
  BoundedSampleBuffer,
  ResourceGovernor,
  calculateResourceTrends,
  type ResourceGovernorSample,
} from "../../src/browser/resourceGovernor.js";
import {
  CoordinatorRuntime,
  type CoordinatorTargetLease,
} from "../../src/browser/coordinatorRuntime.js";
import { BrowserCoordinatorStore } from "../../src/browser/coordinatorStore.js";
import {
  sampleOwnedChromeTree,
  type ProcessSnapshot,
  type ProcessSnapshotProvider,
  type ProcessTreeSample,
} from "../../src/browser/resourceTelemetry.js";
import {
  runResourceSoak,
  type ResourceSoakDependencies,
  type ResourceSoakTargetInventory,
} from "../../scripts/resource-soak.js";

const MiB = 1024 ** 2;
const FIXTURE_RSS_BOUND_BYTES = 64 * MiB;
const fixtureProcesses: readonly ProcessSnapshot[] = [
  {
    pid: 90_000,
    ppid: null,
    startToken: "fixture-root",
    rssBytes: 32 * MiB,
    workingSetBytes: 32 * MiB,
    cpuPercent: 2,
    cpuTimeMs: 10,
    command: "chrome --type=browser --user-data-dir=<redacted-profile>",
    processType: "browser",
  },
  {
    pid: 90_001,
    ppid: 90_000,
    startToken: "fixture-renderer",
    rssBytes: 12 * MiB,
    workingSetBytes: 12 * MiB,
    cpuPercent: 1,
    cpuTimeMs: 4,
    command: "chrome --type=renderer",
    processType: "renderer",
  },
  {
    pid: 90_002,
    ppid: 90_000,
    startToken: "fixture-gpu",
    rssBytes: 8 * MiB,
    workingSetBytes: 8 * MiB,
    cpuPercent: 1,
    cpuTimeMs: 3,
    command: "chrome --type=gpu-process",
    processType: "gpu",
  },
];

const fixtureProvider: ProcessSnapshotProvider = {
  async listProcesses() {
    return fixtureProcesses;
  },
};

const verifiedIdentity = {
  expected: {
    pid: 90_000,
    startToken: "fixture-root",
    profilePath: "<redacted-profile>",
    commandIncludes: ["chrome"],
    generation: "fixture-generation",
  },
  observed: {
    pid: 90_000,
    startToken: "fixture-root",
    command: "chrome --type=browser --user-data-dir=<redacted-profile>",
    generation: "fixture-generation",
  },
} as const;

const dirs: string[] = [];
const stores: BrowserCoordinatorStore[] = [];
const runtimes: CoordinatorRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-resource-cycle-"));
  dirs.push(directory);
  return path.join(directory, "coordinator.sqlite");
}

function activeTargets(store: BrowserCoordinatorStore): number {
  return store
    .listTargets()
    .filter((target) => ["admitted", "active", "closing"].includes(target.state)).length;
}

async function verifyNoActiveTargets(databasePathValue: string): Promise<void> {
  const verifier = new BrowserCoordinatorStore({
    profileId: "resource-cycle-fixture",
    databasePath: databasePathValue,
  });
  stores.push(verifier);
  expect(activeTargets(verifier)).toBe(0);
}

describe("bounded resource cycle proof", () => {
  test("runs 200 submit/evict/poll cycles with real coordinator and adaptive scheduler state", async () => {
    const databasePathValue = await databasePath();
    const timers: Array<() => void> = [];
    const timerDelays: number[] = [];
    const samples = new BoundedSampleBuffer<ProcessTreeSample>(256);
    const checks: Array<{
      operation: string;
      mutationReleased: boolean;
      activeAfterPollRelease: number;
    }> = [];
    const errors: unknown[] = [];
    let currentNowMs = 100_000;
    let cycle = 0;
    let settle: (() => void) | undefined;

    const scheduler = new AdaptivePollingScheduler<{
      runtime: CoordinatorRuntime;
      lease: CoordinatorTargetLease;
      operation: string;
      mutationReleased: boolean;
    }>({
      now: () => currentNowMs,
      setTimeout: (callback, delayMs) => {
        timers.push(callback);
        timerDelays.push(delayMs);
        return callback;
      },
      clearTimeout: (timer) => {
        const index = timers.indexOf(timer as () => void);
        if (index >= 0) timers.splice(index, 1);
      },
      acquirePollingLease: async (job: ScheduledAdaptivePollJob) => {
        const runtime = new CoordinatorRuntime(
          { host: "127.0.0.1", port: 19_222 },
          {
            databasePath: databasePathValue,
            profileId: "resource-cycle-fixture",
            ownerPid: 42_001,
            ownerStartToken: "fixture-owner",
            targetCeilings: { total: 2 },
            now: () => currentNowMs,
          },
        );
        runtimes.push(runtime);
        const operation = cycle % 2 === 0 ? "chatgpt_create_session" : "chatgpt_work_start";
        const lease = await runtime.reserve({ role: "polling", ownerJobId: job.id });
        await lease.bind(`poll-target-${cycle}`);
        return { runtime, lease, operation, mutationReleased: false };
      },
      poll: async (job, pollingLease) => {
        const operation = pollingLease.operation;
        const mutationLease = await pollingLease.runtime.reserve({
          role: "mutation",
          ownerJobId: operation,
        });
        await mutationLease.bind(`mutation-target-${cycle}`);
        const sampled = await sampleOwnedChromeTree({
          rootPid: 90_000,
          generation: "fixture-generation",
          targetCount: activeTargets(pollingLease.runtime.store),
          targetTypes: { polling: 1, mutation: 1 },
          provider: fixtureProvider,
          now: () => new Date(currentNowMs),
        });
        samples.push(sampled);
        await mutationLease.release({ confirmed: true });
        pollingLease.mutationReleased = true;
        cycle += 1;
        return {
          state: cycle === 200 ? "succeeded" : "running",
          progress: true,
          progressAt: currentNowMs,
        };
      },
      releasePollingLease: async (pollingLease) => {
        await pollingLease.lease.release({ confirmed: true });
        checks.push({
          operation: pollingLease.operation,
          mutationReleased: pollingLease.mutationReleased,
          activeAfterPollRelease: pollingLease.runtime.reservationCount,
        });
        settle?.();
      },
      onPollError: (error) => {
        errors.push(error);
        settle?.();
      },
      plan: { minDelayMs: 1, maxDelayMs: 10, backoffFactor: 1, jitterRatio: 0 },
    });

    await scheduler.scheduleNonresidentPoll({
      id: "resource-cycle-job",
      state: { state: "running", attempts: 0, dueAt: new Date(currentNowMs + 1).toISOString() },
    });

    for (let index = 0; index < 200; index += 1) {
      const timer = timers.shift();
      expect(timer, `missing due poll at cycle ${index + 1}`).toBeDefined();
      currentNowMs += 10;
      let resolve!: () => void;
      const settled = new Promise<void>((res) => {
        resolve = res;
      });
      settle = resolve;
      timer!();
      await settled;
      for (let spin = 0; scheduler.activePollCount !== 0 && spin < 32; spin += 1) {
        await Promise.resolve();
      }
      for (
        let spin = 0;
        timers.length === 0 && scheduler.pendingCount === 0 && spin < 32;
        spin += 1
      ) {
        await Promise.resolve();
      }
      expect(checks[index]).toMatchObject({
        operation: index % 2 === 0 ? "chatgpt_create_session" : "chatgpt_work_start",
        mutationReleased: true,
        activeAfterPollRelease: 0,
      });
    }

    expect(errors).toEqual([]);
    expect(cycle).toBe(200);
    expect(timerDelays).toHaveLength(200);
    expect(timerDelays.every((delayMs) => delayMs >= 1)).toBe(true);
    expect(scheduler.pendingCount).toBe(0);
    expect(samples.size).toBe(200);
    expect(
      samples
        .values()
        .every((sample) => sample.rssBytes > 0 && sample.rssBytes <= FIXTURE_RSS_BOUND_BYTES),
    ).toBe(true);
    expect(samples.values().every((sample) => sample.sampledAtMs >= 100_000)).toBe(true);
    expect(calculateResourceTrends(samples.values()).rssBytes).toMatchObject({
      first: 52 * MiB,
      last: 52 * MiB,
      direction: "stable",
    });
    expect(
      checks.every((check) => check.activeAfterPollRelease === 0 && check.mutationReleased),
    ).toBe(true);
    await verifyNoActiveTargets(databasePathValue);
  });

  test("exercises hard-watermark ownership, identity evidence, grace, hysteresis, and recovery", () => {
    const governor = new ResourceGovernor({
      pageSoftCeiling: 2,
      pageHardCeiling: 3,
      rssSoftBytes: 48 * MiB,
      rssHardBytes: 56 * MiB,
      rssResumeBytes: 40 * MiB,
      residentGraceMs: 100,
    });
    const sample = (
      rssBytes: number,
      targetCount: number,
      sampledAtMs: number,
    ): ResourceGovernorSample => ({
      rssBytes,
      targetCount,
      sampledAtMs,
    });

    const ownedVerified = governor.decide({
      sample: sample(56 * MiB, 1, 1_000),
      ownership: "owned",
      identity: verifiedIdentity,
    });
    expect(ownedVerified).toMatchObject({
      action: "hard_stop",
      reason: "rss_hard_watermark",
      outcome: "resource_exhausted",
      terminationEligible: true,
      shouldTerminate: true,
    });
    expect(ownedVerified.identityValidation).toEqual({ eligible: true, mismatches: [] });

    const ownedUnverified = new ResourceGovernor({
      pageSoftCeiling: 2,
      pageHardCeiling: 3,
      rssSoftBytes: 48 * MiB,
      rssHardBytes: 56 * MiB,
      rssResumeBytes: 40 * MiB,
      residentGraceMs: 100,
    }).decide({
      sample: sample(56 * MiB, 1, 1_000),
      ownership: "owned",
      identity: {
        ...verifiedIdentity,
        observed: { ...verifiedIdentity.observed, startToken: "reused-pid" },
      },
    });
    expect(ownedUnverified).toMatchObject({
      action: "hard_stop",
      reason: "rss_hard_watermark",
      terminationEligible: false,
      shouldTerminate: false,
      outcome: "resource_exhausted",
    });
    expect(ownedUnverified.identityValidation).toMatchObject({
      eligible: false,
      mismatches: ["start-token-mismatch"],
    });

    const adopted = new ResourceGovernor({
      pageSoftCeiling: 2,
      pageHardCeiling: 3,
      rssSoftBytes: 48 * MiB,
      rssHardBytes: 56 * MiB,
      rssResumeBytes: 40 * MiB,
      residentGraceMs: 100,
    }).decide({ sample: sample(56 * MiB, 3, 1_000), ownership: "adopted" });
    expect(adopted).toMatchObject({
      action: "remote_detach_only",
      reason: "page_hard_ceiling",
      terminationEligible: false,
      shouldTerminate: false,
      outcome: "resource_exhausted",
    });
    expect(adopted.identityValidation).toBeNull();

    const grace = governor.decide({
      sample: sample(56 * MiB, 1, 2_000),
      ownership: "owned",
      residentTransaction: true,
      identity: verifiedIdentity,
    });
    expect(grace).toMatchObject({
      action: "pause_admission",
      phase: "resident_grace",
      reason: "resident_transaction_grace",
      terminationEligible: false,
      shouldTerminate: false,
      graceRemainingMs: 100,
    });
    const exhausted = governor.decide({
      sample: sample(56 * MiB, 1, 2_101),
      ownership: "owned",
      residentTransaction: true,
      identity: verifiedIdentity,
    });
    expect(exhausted).toMatchObject({
      action: "hard_stop",
      phase: "hard",
      reason: "rss_hard_watermark",
      outcome: "resource_exhausted_unknown",
      graceRemainingMs: 0,
      terminationEligible: true,
      shouldTerminate: true,
    });

    const hysteresis = governor.decide({
      sample: sample(44 * MiB, 1, 2_110),
      ownership: "owned",
      identity: verifiedIdentity,
    });
    expect(hysteresis).toMatchObject({
      action: "pause_admission",
      phase: "soft",
      reason: "hysteresis",
      shouldTerminate: false,
    });
    const recovery = governor.decide({
      sample: sample(40 * MiB, 1, 2_120),
      ownership: "owned",
      identity: verifiedIdentity,
    });
    expect(recovery).toMatchObject({
      action: "admit",
      phase: "normal",
      reason: "below_limits",
      canAdmit: true,
    });
  });
  test("writes soak evidence only when the isolated Chrome root is sampled and cleaned", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "oracle-resource-soak-test-"));
    dirs.push(outputDirectory);
    let targetOpen = false;
    let chromeKilled = false;
    const baseline: ResourceSoakTargetInventory = {
      count: 1,
      types: { page: 1 },
      pageIds: ["baseline-page"],
    };
    const inventory = async (): Promise<ResourceSoakTargetInventory> =>
      targetOpen
        ? { count: 2, types: { page: 2 }, pageIds: ["baseline-page", "cycle-page"] }
        : baseline;
    const dependencies: ResourceSoakDependencies = {
      launch: async () => ({
        pid: 91_000,
        port: 19_224,
        kill: async () => {
          chromeKilled = true;
        },
      }),
      connect: async () => ({
        Target: {
          createTarget: async () => {
            targetOpen = true;
            return { targetId: "cycle-page" };
          },
          closeTarget: async () => {
            targetOpen = false;
            return { success: true };
          },
        },
        close: async () => undefined,
      }),
      listTargets: async () => await inventory(),
      sampleTree: async ({ rootPid }): Promise<ProcessTreeSample> => ({
        sampledAt: "2026-01-01T00:00:00.000Z",
        sampledAtMs: 1,
        rootPid,
        rootFound: !chromeKilled,
        targetCount: targetOpen ? 2 : 1,
        targetTypes: { page: targetOpen ? 2 : 1 },
        processCount: chromeKilled ? 0 : 2,
        processTypeCounts: chromeKilled ? {} : { browser: 1, renderer: 1 },
        rssBytes: chromeKilled ? 0 : 32 * MiB,
        workingSetBytes: chromeKilled ? 0 : 32 * MiB,
        cpuPercent: 1,
        cpuTimeMs: 1,
        processes: [],
      }),
      wait: async () => undefined,
    };
    const result = await runResourceSoak(
      {
        durationMs: 1,
        sampleIntervalMs: 1,
        outputPath: path.join(outputDirectory, "soak.json"),
        deterministicOutputPath: path.join(outputDirectory, "fixture.json"),
      },
      dependencies,
    );
    const artifact = JSON.parse(await readFile(result.soakPath, "utf8")) as Record<string, unknown>;
    expect(chromeKilled).toBe(true);
    expect(artifact.realProcessSampling).toBe(true);
    expect(artifact.chrome).toMatchObject({
      isolated: true,
      cleanupConfirmed: true,
      rootFoundSamples: 1,
      nonzeroProcessSamples: 1,
    });
    expect(artifact.orphans).toMatchObject({
      cycles: [
        {
          activeLeasesAfterRelease: 0,
          pagesOutsideBaselineAfterRelease: 0,
          baselineRestored: true,
        },
      ],
    });
    const failedOutput = path.join(outputDirectory, "failed-soak.json");
    const failedDependencies: ResourceSoakDependencies = {
      ...dependencies,
      launch: async () => ({
        pid: 91_001,
        port: 19_225,
        kill: async () => undefined,
      }),
      sampleTree: async ({ rootPid }) => ({
        sampledAt: "2026-01-01T00:00:00.000Z",
        sampledAtMs: 1,
        rootPid,
        rootFound: true,
        targetCount: targetOpen ? 2 : 1,
        targetTypes: { page: targetOpen ? 2 : 1 },
        processCount: 2,
        processTypeCounts: { browser: 1, renderer: 1 },
        rssBytes: 32 * MiB,
        workingSetBytes: 32 * MiB,
        cpuPercent: 1,
        cpuTimeMs: 1,
        processes: [],
      }),
    };
    await expect(
      runResourceSoak(
        {
          durationMs: 1,
          sampleIntervalMs: 1,
          outputPath: failedOutput,
          deterministicOutputPath: path.join(outputDirectory, "failed-fixture.json"),
        },
        failedDependencies,
      ),
    ).rejects.toThrow(/cleanup|live-process/i);
    await expect(readFile(failedOutput, "utf8")).rejects.toThrow();
  });
});
