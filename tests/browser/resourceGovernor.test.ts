import { describe, expect, test } from "vitest";
import {
  DEFAULT_RESOURCE_GOVERNOR_CONFIG,
  ResourceGovernor,
  calculateResourceTrends,
  downsampleSamples,
  retainBoundedSamples,
  type ResourceGovernorSample,
} from "../../src/browser/resourceGovernor.js";

const GiB = 1024 ** 3;

function sample(rssBytes: number, targetCount: number, sampledAtMs = 0): ResourceGovernorSample {
  return {
    rssBytes,
    targetCount,
    sampledAtMs,
    processCount: targetCount + 1,
    cpuPercent: 10,
    cpuTimeMs: sampledAtMs,
  };
}

const identity = {
  expected: {
    pid: 42,
    startToken: "start-1",
    profilePath: "/tmp/profile",
    commandIncludes: ["chrome"],
    generation: "generation-1",
  },
  observed: {
    pid: 42,
    startToken: "start-1",
    command: "chrome --user-data-dir=/tmp/profile",
    generation: "generation-1",
  },
} as const;

function governor() {
  return new ResourceGovernor({
    pageSoftCeiling: 2,
    pageHardCeiling: 3,
    rssSoftBytes: 3 * GiB,
    rssHardBytes: 4 * GiB,
    rssResumeBytes: 2.5 * GiB,
    residentGraceMs: 100,
  });
}

describe("resource governor", () => {
  test("admits under limits, pauses at soft watermark, and resumes only below the resume watermark", () => {
    const resourceGovernor = governor();
    expect(
      resourceGovernor.decide({ sample: sample(1 * GiB, 1), ownership: "owned", identity }).action,
    ).toBe("admit");

    const soft = resourceGovernor.decide({
      sample: sample(3 * GiB, 1, 10),
      ownership: "owned",
      identity,
    });
    expect(soft.action).toBe("pause_admission");
    expect(soft.actions).toEqual(["pause_admission", "close_idle_targets", "schedule_recycle"]);

    const hysteresis = resourceGovernor.decide({
      sample: sample(2.75 * GiB, 1, 20),
      ownership: "owned",
      identity,
    });
    expect(hysteresis.reason).toBe("hysteresis");
    expect(hysteresis.action).toBe("pause_admission");

    const resumed = resourceGovernor.decide({
      sample: sample(2.5 * GiB, 1, 30),
      ownership: "owned",
      identity,
    });
    expect(resumed.action).toBe("admit");
  });

  test("enforces page hard ceiling and validates process identity before termination", () => {
    const resourceGovernor = governor();
    const decision = resourceGovernor.decide({
      sample: sample(1 * GiB, 3),
      ownership: "owned",
      identity,
    });
    expect(decision.action).toBe("hard_stop");
    expect(decision.terminationEligible).toBe(true);
    expect(decision.shouldTerminate).toBe(true);
  });

  test("rejects stale PID identity evidence", () => {
    const resourceGovernor = governor();
    const decision = resourceGovernor.decide({
      sample: sample(4 * GiB, 1),
      ownership: "owned",
      identity: { ...identity, observed: { ...identity.observed, startToken: "reused-pid" } },
    });
    expect(decision.action).toBe("hard_stop");
    expect(decision.terminationEligible).toBe(false);
    expect(decision.shouldTerminate).toBe(false);
    expect(decision.identityValidation?.mismatches).toContain("start-token-mismatch");
  });

  test("adopted Chrome is never eligible for kill and detaches remotely at hard watermark", () => {
    const resourceGovernor = governor();
    const decision = resourceGovernor.decide({ sample: sample(4 * GiB, 3), ownership: "adopted" });
    expect(decision.action).toBe("remote_detach_only");
    expect(decision.actions).toContain("remote_detach_only");
    expect(decision.terminationEligible).toBe(false);
    expect(decision.shouldTerminate).toBe(false);
  });

  test("gives resident work bounded grace, then reports unknown resource exhaustion", () => {
    const resourceGovernor = governor();
    const grace = resourceGovernor.decide({
      sample: sample(4 * GiB, 1, 1_000),
      ownership: "owned",
      residentTransaction: true,
      identity,
    });
    expect(grace.action).toBe("pause_admission");
    expect(grace.graceRemainingMs).toBe(100);
    expect(grace.outcome).toBeUndefined();
    expect(grace.shouldTerminate).toBe(false);

    const exhausted = resourceGovernor.decide({
      sample: sample(4 * GiB, 1, 1_101),
      ownership: "owned",
      residentTransaction: true,
      identity,
    });
    expect(exhausted.action).toBe("hard_stop");
    expect(exhausted.graceRemainingMs).toBe(0);
    expect(exhausted.outcome).toBe("resource_exhausted_unknown");
    expect(exhausted.shouldTerminate).toBe(true);
  });

  test("retains bounded samples, downsamples deterministically, and computes process trends", () => {
    const samples = Array.from({ length: 10 }, (_, index) =>
      sample(index * 100, index, index * 1_000),
    );
    expect(retainBoundedSamples(samples, 3).map((entry) => entry.sampledAtMs)).toEqual([
      7_000, 8_000, 9_000,
    ]);
    expect(downsampleSamples(samples, 4).map((entry) => entry.sampledAtMs)).toEqual([
      0, 3_000, 6_000, 9_000,
    ]);
    expect(downsampleSamples(samples, 2).map((entry) => entry.sampledAtMs)).toEqual([0, 9_000]);
    expect(calculateResourceTrends(samples)).toMatchObject({
      sampleCount: 10,
      processCount: { first: 1, last: 10, delta: 9, direction: "rising" },
      rssBytes: { first: 0, last: 900, delta: 900, direction: "rising" },
    });
  });

  test("leaves uncalibrated RSS watermarks disabled by default", () => {
    expect(DEFAULT_RESOURCE_GOVERNOR_CONFIG.rssSoftBytes).toBeNull();
    expect(DEFAULT_RESOURCE_GOVERNOR_CONFIG.rssHardBytes).toBeNull();
    expect(DEFAULT_RESOURCE_GOVERNOR_CONFIG.rssResumeBytes).toBeNull();

    const resourceGovernor = new ResourceGovernor();
    expect(
      resourceGovernor.decide({ sample: sample(100 * GiB, 1), ownership: "owned", identity })
        .action,
    ).toBe("admit");
  });
});
