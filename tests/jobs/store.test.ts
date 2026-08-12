import { mkdtemp, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
  OracleJobAdmissionError,
  OracleJobIdempotencyConflictError,
  OracleJobStore,
} from "../../src/jobs/store.js";

describe("OracleJobStore", () => {
  test("creates, updates, reads events, and persists results", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "oracle-jobs-store-"));
    const store = new OracleJobStore({ rootDir });
    const job = await store.createJob({
      kind: "test_sleep",
      input: { prompt: "hello", files: ["a.png"], outputDir: "/tmp/out" },
    });

    expect(job.id).toMatch(/^job_/);
    expect(job.inputSummary).toMatchObject({
      promptChars: 5,
      attachmentCount: 1,
      outputDir: "/tmp/out",
    });

    const running = await store.transitionJob(
      job.id,
      "running",
      "waiting_for_response",
      "Waiting.",
    );
    expect(running.status).toBe("running");
    await store.appendEvent(job.id, "info", "waiting_for_response", "Still waiting.");
    await store.writeResult(job.id, { answerText: "yes", warnings: [] });
    await store.transitionJob(job.id, "completed", "completed", "Done.");

    const rereadStore = new OracleJobStore({ rootDir });
    const reread = await rereadStore.readJob(job.id);
    expect(reread?.status).toBe("completed");
    expect(reread?.resultSummary?.answerChars).toBe(3);

    const events = await rereadStore.readEvents(job.id);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect((await rereadStore.readEvents(job.id, 2)).map((event) => event.seq)).toEqual([3, 4]);

    const result = await rereadStore.readResult(job.id);
    expect(result.ready).toBe(true);
    expect(result.result).toEqual({ answerText: "yes", warnings: [] });

    await rm(rootDir, { recursive: true, force: true });
  });

  test("reconciles interrupted active jobs after restart", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "oracle-jobs-reconcile-"));
    const store = new OracleJobStore({ rootDir });
    const job = await store.createJob({ kind: "test_sleep", input: { ms: 1000 } });
    await store.transitionJob(job.id, "running", "waiting_for_response", "Running.");

    const reconciled = await new OracleJobStore({ rootDir }).reconcileInterruptedJobs();
    expect(reconciled).toHaveLength(1);
    const reread = await store.readJob(job.id);
    expect(reread?.status).toBe("requires_action");
    expect(reread?.outcome).toBe("requires_action");
    expect(reread?.error?.code).toBe("submission_unknown");

    await rm(rootDir, { recursive: true, force: true });
  });

  test("rejects stale CAS transitions and preserves monotonic events", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "oracle-jobs-cas-"));
    const store = new OracleJobStore({ rootDir });
    const job = await store.createJob({
      kind: "test_sleep",
      input: {},
      idempotencyKey: "cas-key",
    });
    const transitioned = await store.transitionJob({
      id: job.id,
      expectedStatus: "queued",
      nextStatus: "running",
      phase: "queued",
      generation: 1,
    });
    expect(transitioned?.status).toBe("running");
    expect(
      await store.transitionJob({
        id: job.id,
        expectedStatus: "queued",
        nextStatus: "completed",
        phase: "completed",
        outcome: "success",
      }),
    ).toBeNull();
    await Promise.all([
      store.appendEvent({
        id: job.id,
        level: "info",
        phase: "queued",
        message: "first",
        timestamp: "2020-01-01T00:00:00.000Z",
      }),
      store.appendEvent({
        id: job.id,
        level: "info",
        phase: "queued",
        message: "second",
        timestamp: "2019-01-01T00:00:00.000Z",
      }),
    ]);
    const events = await store.readEvents(job.id);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(Date.parse(events[3].timestamp)).toBeGreaterThanOrEqual(Date.parse(events[2].timestamp));
    await expect(
      store.createJob({
        kind: "test_sleep",
        input: { different: true },
        idempotencyKey: "cas-key",
      }),
    ).rejects.toBeInstanceOf(OracleJobIdempotencyConflictError);
    await rm(rootDir, { recursive: true, force: true });
  });

  test("rejects job identifiers that are not a single safe path component", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "oracle-jobs-id-path-"));
    const store = new OracleJobStore({ rootDir });
    await expect(store.readJob("../job_other")).rejects.toThrow("Invalid Oracle job id");
    await expect(store.readJob("job_safe/../../job_other")).rejects.toThrow(
      "Invalid Oracle job id",
    );
    await rm(rootDir, { recursive: true, force: true });
  });

  test("listing skips corrupt job records", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "oracle-jobs-corrupt-"));
    const store = new OracleJobStore({ rootDir });
    await store.createJob({ kind: "test_sleep", input: {} });
    await rm(path.join(rootDir, "job_corrupt"), { recursive: true, force: true });

    const jobs = await store.listJobs();
    expect(jobs).toHaveLength(1);

    await rm(rootDir, { recursive: true, force: true });
  });
  test("admits one durable winner across concurrent store instances", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "oracle-jobs-admission-"));
    const stores = Array.from({ length: 100 }, () => new OracleJobStore({ rootDir }));
    let ready = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admissions = await Promise.all(
      stores.map(async (store) => {
        ready += 1;
        if (ready === stores.length) release();
        await barrier;
        return await store.admitJob({
          kind: "test_sleep",
          input: { prompt: "same" },
          idempotencyKey: "concurrent-key",
        });
      }),
    );
    expect(new Set(admissions.map(({ job }) => job.id)).size).toBe(1);
    expect(admissions.filter(({ created }) => created)).toHaveLength(1);
    await stores[0].writeResult(admissions[0].job.id, { answerText: "one" });
    expect(await stores[0].listJobs(Number.MAX_SAFE_INTEGER)).toHaveLength(1);
    expect((await stores[0].readResult(admissions[0].job.id)).result).toEqual({
      answerText: "one",
    });

    const distinct = await Promise.all(
      stores.map((store, index) =>
        store.admitJob({
          kind: "test_sleep",
          input: { index },
          idempotencyKey: `distinct-${index}`,
        }),
      ),
    );
    expect(new Set(distinct.map(({ job }) => job.id)).size).toBe(100);
    expect(await stores[0].listJobs(Number.MAX_SAFE_INTEGER)).toHaveLength(101);
    await rm(rootDir, { recursive: true, force: true });
  }, 30_000);

  test("preserves admission accounting across store restart", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "oracle-jobs-restart-accounting-"));
    const first = new OracleJobStore({ rootDir, maxQueuedJobs: 1 });
    await first.createJob({ kind: "test_sleep", input: { value: 1 }, principalHash: "p" });
    const restarted = new OracleJobStore({ rootDir, maxQueuedJobs: 1 });
    await expect(
      restarted.createJob({ kind: "test_sleep", input: { value: 2 }, principalHash: "p" }),
    ).rejects.toMatchObject({ reason: "queued_jobs_exhausted", statusCode: 429 });
    await rm(rootDir, { recursive: true, force: true });
  });

  test("enforces principal quotas atomically across store instances", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "oracle-jobs-principal-quota-"));
    const stores = [
      new OracleJobStore({ rootDir, maxQueuedJobs: 100, maxPrincipalQueuedJobs: 2 }),
      new OracleJobStore({ rootDir, maxQueuedJobs: 100, maxPrincipalQueuedJobs: 2 }),
    ];
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        stores[index % stores.length].createJob({
          kind: "test_sleep",
          input: { index },
          idempotencyKey: `principal-${index}`,
          principalHash: "same-principal",
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(
      results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .every((result) => result.reason instanceof OracleJobAdmissionError),
    ).toBe(true);
    await rm(rootDir, { recursive: true, force: true });
  }, 30_000);

  test("rejects before creating a job directory", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "oracle-jobs-rejected-"));
    const store = new OracleJobStore({ rootDir, maxQueuedJobs: 0 });
    await expect(
      store.createJob({ kind: "test_sleep", input: { rejected: true } }),
    ).rejects.toBeInstanceOf(OracleJobAdmissionError);
    expect((await readdir(rootDir)).filter((entry) => entry.startsWith("job_"))).toHaveLength(0);
    await rm(rootDir, { recursive: true, force: true });
  });

  test("terminal jobs release queued input quota and remain retention-prunable", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "oracle-jobs-prune-quota-"));
    const store = new OracleJobStore({
      rootDir,
      maxQueuedJobs: 10,
      maxQueuedPersistedInputBytes: 32,
      maxPrincipalQueuedJobs: 10,
      maxPrincipalQueuedInputBytes: 32,
      maxPrincipalAdmissionsPerWindow: 10,
    });
    const first = await store.createJob({ kind: "test_sleep", input: { payload: "123456789" } });
    await store.transitionJob(first.id, "completed", "completed", "Done.");
    await expect(
      store.createJob({ kind: "test_sleep", input: { payload: "123456789" } }),
    ).resolves.toBeDefined();
    await delay(5);
    expect(await store.pruneJobs(0)).toContain(first.id);
    await rm(rootDir, { recursive: true, force: true });
  });
});
