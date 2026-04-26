import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { OracleDaemonClient } from "../../src/daemon/client.js";
import { createOracleDaemonServer } from "../../src/daemon/server.js";
import { OracleJobStore } from "../../src/jobs/store.js";

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

  test("cancelling a running non-cooperative job releases the queue slot", async () => {
    const jobDir = await mkdtemp(path.join(os.tmpdir(), "oracle-daemon-cancel-running-"));
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
            const record = input as { mode?: string };
            if (record.mode === "stuck") {
              await context.setPhase("waiting_for_response", "Intentionally stuck.");
              await new Promise((resolve) => setTimeout(resolve, 10_000));
              return { late: true };
            }
            await context.setPhase("waiting_for_response", "Fast job.");
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
    const stuck = await client.startJob({ kind: "test_sleep", input: { mode: "stuck" } });
    const next = await client.startJob({ kind: "test_sleep", input: { mode: "fast" } });

    const cancelled = (await client.cancelJob(stuck.jobId)) as any;
    expect(cancelled.job.status).toBe("cancelled");

    let nextStatus: any;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      nextStatus = await client.jobStatus(next.jobId);
      if (nextStatus.job?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(nextStatus.job.status).toBe("completed");

    const stuckStatus = (await client.jobStatus(stuck.jobId)) as any;
    expect(stuckStatus.job.status).toBe("cancelled");

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
    const status = (await restartedClient.jobStatus(stale.id)) as any;
    expect(status.job.status).toBe("failed");
    expect(status.job.error.code).toBe("daemon_restarted");

    await restarted.close();
    await rm(jobDir, { recursive: true, force: true });
  });
});
