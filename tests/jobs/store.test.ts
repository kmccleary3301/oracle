import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { OracleJobStore } from "../../src/jobs/store.js";

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
    expect(reread?.status).toBe("failed");
    expect(reread?.error?.code).toBe("daemon_restarted");

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
});
