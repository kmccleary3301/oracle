import { describe, expect, test, vi } from "vitest";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import {
  startOwnedChromeResourceWatchdog,
  terminateVerifiedOwnedChromeTree,
  type BrowserResourceWatchdogConfig,
  type BrowserResourceWatchdogOptions,
} from "../../src/browser/resourceWatchdog.js";
import type { ProcessTreeSample } from "../../src/browser/resourceTelemetry.js";

const ROOT_PID = 42;
const PROFILE_PATH = "/tmp/oracle-owned-profile";
const config: BrowserResourceWatchdogConfig = {
  pollIntervalMs: 60_000,
  rssResumeBytes: 100,
  rssSoftBytes: 200,
  rssHardBytes: 300,
  maxConsecutiveSampleFailures: 3,
};

function sample(rssBytes: number, startToken = "start-1"): ProcessTreeSample {
  return {
    sampledAt: "2026-08-10T00:00:00.000Z",
    sampledAtMs: 1,
    rootPid: ROOT_PID,
    rootFound: true,
    targetCount: null,
    targetTypes: {},
    processCount: 1,
    processTypeCounts: { browser: 1 },
    rssBytes,
    workingSetBytes: rssBytes,
    cpuPercent: 1,
    cpuTimeMs: 1,
    processes: [
      {
        pid: ROOT_PID,
        ppid: 1,
        startToken,
        rssBytes,
        workingSetBytes: rssBytes,
        cpuPercent: 1,
        cpuTimeMs: 1,
        command: `chrome --user-data-dir=${PROFILE_PATH}`,
        processType: "browser",
      },
    ],
  };
}

function logger() {
  return Object.assign(vi.fn<(message: string) => void>(), { verbose: false });
}

describe("owned Chrome resource watchdog", () => {
  test("stops an identity-verified owned Chrome tree at the hard RSS limit", async () => {
    const samples = [sample(150), sample(301)];
    const onHardLimit = vi.fn(async () => undefined);
    const watchdog = await startOwnedChromeResourceWatchdog(
      {
        rootPid: ROOT_PID,
        profilePath: PROFILE_PATH,
        logger: logger(),
        config,
        onHardLimit,
      },
      { sample: async () => samples.shift() ?? sample(301) },
    );
    const exhaustion = watchdog.exhaustion.catch((error: unknown) => error);

    await watchdog.sampleNow();

    const error = await exhaustion;
    expect(error).toBeInstanceOf(BrowserAutomationError);
    expect((error as BrowserAutomationError).details).toMatchObject({
      stage: "browser-resource-limit",
      reason: "rss_hard_watermark",
      rssBytes: 301,
      rssHardBytes: 300,
    });
    expect(onHardLimit).toHaveBeenCalledOnce();
  });

  test("refuses destructive shutdown when the Chrome PID identity changed", async () => {
    const samples = [sample(150), sample(301, "reused-pid")];
    const onHardLimit = vi.fn(async () => undefined);
    const watchdog = await startOwnedChromeResourceWatchdog(
      {
        rootPid: ROOT_PID,
        profilePath: PROFILE_PATH,
        logger: logger(),
        config,
        onHardLimit,
      },
      { sample: async () => samples.shift() ?? sample(301, "reused-pid") },
    );
    const exhaustion = watchdog.exhaustion.catch((error: unknown) => error);

    await watchdog.sampleNow();

    expect((await exhaustion) as BrowserAutomationError).toMatchObject({
      details: {
        stage: "browser-resource-limit",
        reason: expect.stringContaining("start-token-mismatch"),
      },
    });
    expect(onHardLimit).not.toHaveBeenCalled();
  });

  test("publishes soft admission pause and hysteresis recovery observations", async () => {
    const samples = [sample(150), sample(250), sample(90)];
    const onSample = vi.fn<NonNullable<BrowserResourceWatchdogOptions["onSample"]>>(
      async () => undefined,
    );
    const onStop = vi.fn();
    const watchdog = await startOwnedChromeResourceWatchdog(
      {
        rootPid: ROOT_PID,
        profilePath: PROFILE_PATH,
        logger: logger(),
        config,
        onSample,
        onStop,
        onHardLimit: vi.fn(async () => undefined),
      },
      { sample: async () => samples.shift() ?? sample(90) },
    );

    await watchdog.sampleNow();
    await watchdog.sampleNow();
    watchdog.stop();
    watchdog.stop();

    expect(onSample.mock.calls.map(([, decision]) => decision.phase)).toEqual(["soft", "normal"]);
    expect(onSample.mock.calls.map(([, decision]) => decision.reason)).toEqual([
      "rss_soft_watermark",
      "below_limits",
    ]);
    expect(onStop).toHaveBeenCalledOnce();
  });

  test("terminates only the identity-stable captured process tree", async () => {
    const root = sample(400);
    const captured = {
      ...root,
      processCount: 2,
      processes: [
        ...root.processes,
        {
          ...root.processes[0]!,
          pid: 43,
          ppid: ROOT_PID,
          startToken: "child-start",
          command: `chrome-helper --user-data-dir=${PROFILE_PATH}`,
          processType: "renderer" as const,
        },
      ],
    };
    let alive = [...captured.processes];
    const signal = vi.fn((pid: number) => {
      alive = alive.filter((candidate) => candidate.pid !== pid);
    });

    const result = await terminateVerifiedOwnedChromeTree(
      {
        expected: {
          pid: ROOT_PID,
          parentPid: 1,
          startToken: "start-1",
          profilePath: PROFILE_PATH,
          generation: "generation-1",
        },
        sample: captured,
        generation: "generation-1",
      },
      {
        processProvider: { listProcesses: async () => alive },
        signal,
        wait: async () => undefined,
      },
    );

    expect(result).toMatchObject({
      terminated: true,
      termSignaledPids: [43, ROOT_PID],
      killSignaledPids: [],
      remainingPids: [],
      reason: "terminated",
    });
  });

  test("refuses adopted-browser termination after PID identity changes", async () => {
    const captured = sample(400);
    const signal = vi.fn();
    const result = await terminateVerifiedOwnedChromeTree(
      {
        expected: {
          pid: ROOT_PID,
          parentPid: 1,
          startToken: "start-1",
          profilePath: PROFILE_PATH,
          generation: "generation-1",
        },
        sample: captured,
        generation: "generation-1",
      },
      {
        processProvider: {
          listProcesses: async () => [{ ...captured.processes[0]!, startToken: "reused-pid" }],
        },
        signal,
        wait: async () => undefined,
      },
    );

    expect(result).toMatchObject({
      terminated: false,
      reason: "identity_mismatch",
      remainingPids: [ROOT_PID],
    });
    expect(signal).not.toHaveBeenCalled();
  });
  test("fails closed after repeated process-sampling failures", async () => {
    let calls = 0;
    const onHardLimit = vi.fn(async () => undefined);
    const watchdog = await startOwnedChromeResourceWatchdog(
      {
        rootPid: ROOT_PID,
        profilePath: PROFILE_PATH,
        logger: logger(),
        config,
        onHardLimit,
      },
      {
        sample: async () => {
          calls += 1;
          if (calls === 1) return sample(150);
          throw new Error("ps unavailable");
        },
      },
    );
    const exhaustion = watchdog.exhaustion.catch((error: unknown) => error);

    await watchdog.sampleNow();
    await watchdog.sampleNow();
    await watchdog.sampleNow();

    expect((await exhaustion) as BrowserAutomationError).toMatchObject({
      details: { stage: "browser-resource-limit", reason: "sampling_unavailable" },
    });
    expect(onHardLimit).toHaveBeenCalledOnce();
  });
});
