import { describe, expect, test, vi } from "vitest";
import {
  AdaptivePollingScheduler,
  computeAdaptivePollPlan,
  type AdaptivePollState,
} from "../../src/jobs/adaptivePolling.js";

describe("adaptive nonresident polling", () => {
  test("adapts thinking classes, resets on progress, and honors rate limits", () => {
    const short = computeAdaptivePollPlan({
      now: 0,
      state: { state: "running", attempts: 3 },
      thinkingClass: "short",
      minDelayMs: 100,
      maxDelayMs: 10_000,
      jitterRatio: 0,
    });
    const long = computeAdaptivePollPlan({
      now: 0,
      state: { state: "running", attempts: 3 },
      thinkingClass: "heavy",
      minDelayMs: 100,
      maxDelayMs: 10_000,
      jitterRatio: 0,
    });
    const progress = computeAdaptivePollPlan({
      now: 0,
      state: { state: "running", attempts: 3 },
      observation: { state: "running", progress: true },
      minDelayMs: 100,
      maxDelayMs: 10_000,
      jitterRatio: 0,
    });
    const limited = computeAdaptivePollPlan({
      now: 0,
      state: { state: "running", attempts: 0 },
      observation: { retryAfterMs: 2_000 },
      minDelayMs: 100,
      maxDelayMs: 500,
      jitterRatio: 0,
    });
    expect(long.delayMs).toBeGreaterThan(short.delayMs!);
    expect(progress.delayMs).toBe(100);
    expect(limited.delayMs).toBe(2_000);
    expect(limited.state.retryAfterMs).toBe(2_000);
  });

  test("jitter is deterministic and terminal plans have no due timer", () => {
    const a = computeAdaptivePollPlan({
      now: 100,
      state: { state: "running", attempts: 2 },
      jitterSeed: "x",
    });
    const b = computeAdaptivePollPlan({
      now: 100,
      state: { state: "running", attempts: 2 },
      jitterSeed: "x",
    });
    const done = computeAdaptivePollPlan({ now: 100, state: { state: "completed", attempts: 2 } });
    expect(a).toEqual(b);
    expect(done.dueAt).toBeUndefined();
    expect(done.terminal).toBe(true);
  });

  test("leases and timers are nonresident, restore after restart, and cancellation wins", async () => {
    vi.useFakeTimers();
    let now = 0;
    const persisted: AdaptivePollState[] = [];
    const leases: string[] = [];
    const released: string[] = [];
    const poll = vi.fn(async () => ({ state: "running" as const }));
    const scheduler = new AdaptivePollingScheduler({
      now: () => now,
      persistPollState: (_id, next) => {
        persisted.push(next);
      },
      acquirePollingLease: async (job) => {
        leases.push(job.id);
        return { id: job.id };
      },
      poll,
      releasePollingLease: async (lease) => {
        released.push(lease.id);
      },
      plan: { minDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 },
    });
    await scheduler.restoreDuePolls([
      { id: "job-1", state: { state: "running", attempts: 0, dueAt: new Date(10).toISOString() } },
    ]);
    expect(scheduler.pendingCount).toBe(1);
    now = 10;
    await vi.runOnlyPendingTimersAsync();
    expect(leases).toEqual(["job-1"]);
    expect(released).toEqual(["job-1"]);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(scheduler.pendingCount).toBe(1);
    await scheduler.cancel("job-1");
    expect(scheduler.pendingCount).toBe(0);
    expect(scheduler.activePollCount).toBe(0);
    await scheduler.close();
    expect(persisted.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});
