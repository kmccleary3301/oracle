import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseBenchmarkConfig,
  redactBenchmarkArtifact,
  runBenchmark,
  summarizeMetric,
} from "../../src/benchmark/workloadHarness.js";

describe("benchmark workload harness", () => {
  test("accepts credential-free descriptors for every supported workload", () => {
    const config = parseBenchmarkConfig({
      schemaVersion: 1,
      mode: "baseline",
      sampleIntervalMs: 250,
      scenarios: [
        { id: "chat-short", kind: "chat", operation: "create", inputShape: "short" },
        {
          id: "upload-small",
          kind: "upload",
          operation: "multiple",
          attachmentCount: 3,
          attachmentBytes: 4096,
        },
        { id: "image-generate", kind: "image", operation: "generate" },
        { id: "research-plan", kind: "research", operation: "approve-plan", inputShape: "long" },
        {
          id: "work-fault",
          kind: "work",
          operation: "start",
          faults: [{ kind: "browser_disconnect", phase: "during" }],
        },
      ],
    });
    expect(config.scenarios).toHaveLength(5);
    expect(config.scenarios[4]?.faults[0]?.kind).toBe("browser_disconnect");
    expect(() =>
      parseBenchmarkConfig({
        schemaVersion: 1,
        mode: "baseline",
        scenarios: [{ id: "leak", kind: "chat", operation: "create", prompt: "private content" }],
      }),
    ).toThrow(/unsupported field|private field/);
  });

  test("validates the checked-in baseline and soak workload matrices", async () => {
    const baseline = parseBenchmarkConfig(
      JSON.parse(await readFile(path.resolve("scripts/benchmark-workloads.json"), "utf8")),
    );
    const soak = parseBenchmarkConfig(
      JSON.parse(await readFile(path.resolve("scripts/benchmark-soak.json"), "utf8")),
    );
    expect(baseline.scenarios).toHaveLength(13);
    expect(baseline.scenarios.flatMap((scenario) => scenario.faults)).toHaveLength(5);
    expect(soak.mode).toBe("soak");
    expect(soak.scenarios[0]).toMatchObject({ iterations: 200, concurrency: 2 });
  });

  test("produces deterministic summary metrics and redacted JSONL artifacts", async () => {
    expect(summarizeMetric([3, 1, 2, null])).toEqual({
      count: 3,
      min: 1,
      max: 3,
      mean: 2,
      median: 2,
      p95: 3,
    });
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "oracle-benchmark-"));
    try {
      const result = await runBenchmark(
        {
          schemaVersion: 1,
          mode: "soak",
          scenarios: [{ id: "chat", kind: "chat", operation: "create", iterations: 2 }],
        },
        {
          outputDir,
          now: (() => {
            let index = 0;
            return () => new Date(`2026-08-10T00:00:0${index++}.000Z`);
          })(),
          sampleResource: async ({ iteration }) => ({
            sampledAtMs: iteration,
            targetCount: iteration + 1,
            processCount: iteration + 2,
            rssBytes: 100 + iteration,
          }),
          executeScenario: async (_scenario, context) => ({
            status: context.iteration === 1 ? "faulted" : "completed",
            reasonCode: "controller_sigkill",
          }),
        },
      );
      expect(result.summary).toMatchObject({
        mode: "soak",
        iterationCount: 2,
        completed: 1,
        faulted: 1,
      });
      const events = await readFile(result.artifacts!.eventsPath, "utf8");
      expect(events).toContain('"type":"resource_sample"');
      expect(events).toContain('"type":"scenario_result"');
      const summary = JSON.parse(await readFile(result.artifacts!.summaryPath, "utf8")) as {
        resources: { rssBytes: { count: number; max: number } };
      };
      expect(summary.resources.rssBytes).toMatchObject({ count: 4, max: 101 });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
  test("bounds concurrent scenario workers and accounts every iteration", async () => {
    let active = 0;
    let maxActive = 0;
    const result = await runBenchmark(
      {
        schemaVersion: 1,
        mode: "baseline",
        scenarios: [
          {
            id: "chat-concurrent",
            kind: "chat",
            operation: "create",
            iterations: 7,
            concurrency: 2,
          },
        ],
      },
      {
        executeScenario: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active -= 1;
          return { status: "completed" };
        },
      },
    );
    expect(maxActive).toBe(2);
    expect(active).toBe(0);
    expect(result.summary).toMatchObject({
      iterationCount: 7,
      completed: 7,
      failed: 0,
      faulted: 0,
    });
    expect(result.summary.scenarios[0]).toMatchObject({ iterations: 7, completed: 7 });
  });

  test("redacts private values even when supplied as event metadata", () => {
    const value = redactBenchmarkArtifact({
      prompt: "private prompt",
      token: "secret-token",
      status: "completed",
      count: 2,
    });
    expect(value).toEqual({
      prompt: "<redacted>",
      token: "<redacted>",
      status: "completed",
      count: 2,
    });
  });
});
