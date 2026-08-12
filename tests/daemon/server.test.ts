import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { OracleDaemonClient } from "../../src/daemon/client.js";
import { createOracleDaemonServer } from "../../src/daemon/server.js";
import { OracleJobStore } from "../../src/jobs/store.js";
import type { OracleDaemonJobHandlerContext } from "../../src/daemon/types.js";

describe("Oracle daemon server", () => {
  test("submits, polls, tails events, and reads result across clients", async () => {
    const jobDir = await mkdtemp(path.join(os.tmpdir(), "oracle-daemon-jobs-"));
    const server = await createOracleDaemonServer({
      host: "127.0.0.1",
      port: 0,
      token: "secret",
      jobDir,
      logger: () => {},
    });
    const firstClient = new OracleDaemonClient({
      host: "127.0.0.1",
      port: server.port,
      token: "secret",
    });
    const started = await firstClient.startJob({
      kind: "test_sleep",
      input: { ms: 10, result: { answerText: "done" } },
    });
    expect(started.jobId).toMatch(/^job_/);
    expect(started.pollTool).toBe("oracle_job_status");

    const secondClient = new OracleDaemonClient({
      host: "127.0.0.1",
      port: server.port,
      token: "secret",
    });
    let status: any;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      status = await secondClient.jobStatus(started.jobId);
      if (status.job?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(status.job.status).toBe("completed");
    expect(status.job.resultReady).toBe(true);

    const events = (await secondClient.jobEvents(started.jobId, 0)) as any;
    expect(events.events.length).toBeGreaterThanOrEqual(4);
    expect(events.events[0].seq).toBe(1);

    const result = (await secondClient.jobResult(started.jobId)) as any;
    expect(result.ready).toBe(true);
    expect(result.result).toEqual({ answerText: "done" });

    await server.close();
    await rm(jobDir, { recursive: true, force: true });
  });

  test("queues beyond max concurrency and can cancel queued jobs", async () => {
    const jobDir = await mkdtemp(path.join(os.tmpdir(), "oracle-daemon-queue-"));
    const server = await createOracleDaemonServer({
      host: "127.0.0.1",
      port: 0,
      token: "secret",
      jobDir,
      maxConcurrentJobs: 1,
      logger: () => {},
    });
    const client = new OracleDaemonClient({
      host: "127.0.0.1",
      port: server.port,
      token: "secret",
    });
    const first = await client.startJob({ kind: "test_sleep", input: { ms: 200 } });
    const second = await client.startJob({ kind: "test_sleep", input: { ms: 200 } });
    expect(first.jobId).not.toBe(second.jobId);

    const secondStatus = (await client.jobStatus(second.jobId)) as any;
    expect(["queued", "running"]).toContain(secondStatus.job.status);

    const cancelled = (await client.cancelJob(second.jobId)) as any;
    expect(cancelled.found).toBe(true);

    await server.close();
    await rm(jobDir, { recursive: true, force: true });
  });

  test("cancelling a running non-cooperative job retains the coordinator slot", async () => {
    const jobDir = await mkdtemp(path.join(os.tmpdir(), "oracle-daemon-cancel-running-"));
    let activeJobs = 0;
    let maxActiveJobs = 0;
    const server = await createOracleDaemonServer({
      host: "127.0.0.1",
      port: 0,
      token: "secret",
      jobDir,
      maxConcurrentJobs: 1,
      logger: () => {},
      handlers: [
        {
          kind: "test_sleep",
          async run(context, input) {
            activeJobs += 1;
            maxActiveJobs = Math.max(maxActiveJobs, activeJobs);
            try {
              const record = input as { mode?: string };
              if (record.mode === "stuck") {
                await context.setPhase("waiting_for_response", "Intentionally stuck.");
                await delay(150);
                return { late: true };
              }
              await context.setPhase("waiting_for_response", "Fast job.");
              return { ok: true };
            } finally {
              activeJobs -= 1;
            }
          },
        },
      ],
    });
    const client = new OracleDaemonClient({
      host: "127.0.0.1",
      port: server.port,
      token: "secret",
    });
    const stuck = await client.startJob({ kind: "test_sleep", input: { mode: "stuck" } });
    const next = await client.startJob({ kind: "test_sleep", input: { mode: "fast" } });

    expect(readJobStatus(await client.cancelJob(stuck.jobId))).toBe("cancel_requested");

    await delay(30);
    expect(readJobStatus(await client.jobStatus(next.jobId))).toBe("queued");

    const completionDeadline = Date.now() + 3_000;
    let nextStatus: string | undefined;
    while (Date.now() < completionDeadline) {
      nextStatus = readJobStatus(await client.jobStatus(next.jobId));
      if (nextStatus === "completed") break;
      await delay(20);
    }
    expect(nextStatus).toBe("completed");
    expect(maxActiveJobs).toBe(1);

    expect(readJobStatus(await client.jobStatus(stuck.jobId))).toBe("cancelled");

    await server.close();
    await rm(jobDir, { recursive: true, force: true });
  }, 10_000);

  test("persists runtime hints across phase updates", async () => {
    const jobDir = await mkdtemp(path.join(os.tmpdir(), "oracle-daemon-runtime-"));
    const server = await createOracleDaemonServer({
      host: "127.0.0.1",
      port: 0,
      token: "secret",
      jobDir,
      maxConcurrentJobs: 1,
      logger: () => {},
      handlers: [
        {
          kind: "test_sleep",
          async run(context) {
            await context.updateRuntime({
              remoteChrome: "127.0.0.1:9222",
              tabId: "target-1",
              conversationUrl: "https://chatgpt.com/c/test",
              conversationId: "test",
            });
            await context.setPhase("waiting_for_response", "Runtime hint persisted.");
            return { ok: true };
          },
        },
      ],
    });
    const client = new OracleDaemonClient({
      host: "127.0.0.1",
      port: server.port,
      token: "secret",
    });
    const started = await client.startJob({ kind: "test_sleep", input: {} });

    let status: any;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      status = await client.jobStatus(started.jobId);
      if (status.job?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(status.job.status).toBe("completed");
    expect(status.job.runtime).toMatchObject({
      daemonPid: expect.any(Number),
      remoteChrome: "127.0.0.1:9222",
      tabId: "target-1",
      conversationUrl: "https://chatgpt.com/c/test",
      conversationId: "test",
    });

    await server.close();
    await rm(jobDir, { recursive: true, force: true });
  });
  test("late handler updates cannot overwrite cancellation", async () => {
    const jobDir = await mkdtemp(path.join(os.tmpdir(), "oracle-daemon-cancel-race-"));
    let context: OracleDaemonJobHandlerContext | undefined;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await createOracleDaemonServer({
      host: "127.0.0.1",
      port: 0,
      token: "secret",
      jobDir,
      maxConcurrentJobs: 1,
      handlers: [
        {
          kind: "test_sleep",
          async run(runContext) {
            context = runContext;
            await blocked;
            return { late: true };
          },
        },
      ],
    });
    const client = new OracleDaemonClient({
      host: "127.0.0.1",
      port: server.port,
      token: "secret",
    });
    const started = await client.startJob({ kind: "test_sleep", input: {} });
    for (let attempt = 0; attempt < 20 && !context; attempt += 1) await delay(10);
    expect(context).toBeDefined();
    expect(readJobStatus(await client.cancelJob(started.jobId))).toBe("cancel_requested");
    await context!.setPhase("waiting_for_response", "late phase");
    await context!.updateRuntime({ conversationUrl: "https://chatgpt.com/c/late" });
    await context!.markSubmission("submitted");
    expect(readJobStatus(await client.jobStatus(started.jobId))).toBe("cancel_requested");
    release();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (readJobStatus(await client.jobStatus(started.jobId)) === "cancelled") break;
      await delay(10);
    }
    expect(readJobStatus(await client.jobStatus(started.jobId))).toBe("cancelled");
    await server.close();
    await rm(jobDir, { recursive: true, force: true });
  });

  test("atomically admits concurrent HTTP submissions once", async () => {
    const jobDir = await mkdtemp(path.join(os.tmpdir(), "oracle-daemon-admission-"));
    let runs = 0;
    const server = await createOracleDaemonServer({
      host: "127.0.0.1",
      port: 0,
      token: "secret",
      jobDir,
      maxConcurrentJobs: 100,
      logger: () => {},
      handlers: [
        {
          kind: "test_sleep",
          async run() {
            runs += 1;
            await delay(20);
            return { answerText: "once" };
          },
        },
      ],
    });
    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        new OracleDaemonClient({
          host: "127.0.0.1",
          port: server.port,
          token: "secret",
        }).startJob({
          kind: "test_sleep",
          input: { prompt: "same" },
          idempotencyKey: "daemon-concurrent-key",
        }),
      ),
    );
    expect(new Set(responses.map((response) => response.jobId)).size).toBe(1);
    const jobId = responses[0].jobId;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (
        (
          await new OracleDaemonClient({
            host: "127.0.0.1",
            port: server.port,
            token: "secret",
          }).jobStatus(jobId)
        ).job?.status === "completed"
      )
        break;
      await delay(10);
    }
    expect(runs).toBe(1);
    expect(
      await new OracleJobStore({ rootDir: jobDir }).listJobs(Number.MAX_SAFE_INTEGER),
    ).toHaveLength(1);
    const conflictResponse = await fetch(`http://127.0.0.1:${server.port}/jobs`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "test_sleep",
        input: { prompt: "different" },
        idempotencyKey: "daemon-concurrent-key",
      }),
    });
    expect(conflictResponse.status).toBe(409);
    await expect(conflictResponse.json()).resolves.toMatchObject({
      error: "idempotency_conflict",
      existingJobId: jobId,
    });
    await server.close();
    await rm(jobDir, { recursive: true, force: true });
  });

  test("marks interrupted active jobs after daemon restart", async () => {
    const jobDir = await mkdtemp(path.join(os.tmpdir(), "oracle-daemon-restart-"));
    const store = new OracleJobStore({ rootDir: jobDir });
    const stale = await store.createJob({ kind: "test_sleep", input: { ms: 10_000 } });
    await store.transitionJob(stale.id, "running", "waiting_for_response", "Running.");

    const restarted = await createOracleDaemonServer({
      host: "127.0.0.1",
      port: 0,
      token: "secret",
      jobDir,
      logger: () => {},
    });
    const restartedClient = new OracleDaemonClient({
      host: "127.0.0.1",
      port: restarted.port,
      token: "secret",
    });
    const status = await restartedClient.jobStatus(stale.id);
    expect(status.job?.status).toBe("requires_action");
    expect(status.job?.outcome).toBe("requires_action");
    expect(status.job?.error?.code).toBe("submission_unknown");

    await restarted.close();
    await rm(jobDir, { recursive: true, force: true });
  });
  test("prunes expired terminal jobs during startup", async () => {
    const jobDir = await mkdtemp(path.join(os.tmpdir(), "oracle-daemon-retention-"));
    const store = new OracleJobStore({ rootDir: jobDir });
    const expired = await store.createJob({ kind: "test_sleep", input: {} });
    await store.transitionJob(expired.id, "completed", "completed", "Done.");
    await delay(5);

    const server = await createOracleDaemonServer({
      host: "127.0.0.1",
      port: 0,
      token: "secret",
      jobDir,
      jobRetentionMs: 0,
      logger: () => {},
    });
    try {
      await expect(store.readJob(expired.id)).resolves.toBeNull();
    } finally {
      await server.close();
      await rm(jobDir, { recursive: true, force: true });
    }
  });
});

function readJobStatus(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "job" in value &&
    value.job &&
    typeof value.job === "object" &&
    "status" in value.job &&
    typeof value.job.status === "string"
  ) {
    return value.job.status;
  }
  throw new Error("Expected a daemon job status response.");
}
