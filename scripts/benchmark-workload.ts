#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseBenchmarkConfig,
  runBenchmark,
  type BenchmarkResourceSample,
  type WorkloadExecutionContext,
  type WorkloadExecutionResult,
  type WorkloadScenarioDescriptor,
} from "../src/benchmark/workloadHarness.js";

interface RunnerModule {
  runWorkload?: (
    scenario: WorkloadScenarioDescriptor,
    context: WorkloadExecutionContext,
  ) => Promise<WorkloadExecutionResult>;
  sampleResource?: (
    context: WorkloadExecutionContext,
  ) => Promise<BenchmarkResourceSample | undefined>;
}

function readFlag(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const configPath = readFlag(argv, "--config");
  const outputDir = readFlag(argv, "--output");
  const runnerPath = readFlag(argv, "--runner");
  if (!configPath) {
    console.error(
      "usage: benchmark-workload --config <manifest.json> --runner <runner.mjs> [--output <dir>]",
    );
    return 2;
  }
  const config = parseBenchmarkConfig(JSON.parse(await readFile(configPath, "utf8")));
  if (argv.includes("--validate")) {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return 0;
  }
  if (!runnerPath) {
    console.error(
      "a semantic --runner module is required; manifests never contain credentials or private content",
    );
    return 2;
  }
  const runner = (await import(pathToFileURL(path.resolve(runnerPath)).href)) as RunnerModule;
  if (typeof runner.runWorkload !== "function") {
    console.error("runner module must export runWorkload(scenario, context)");
    return 2;
  }
  const result = await runBenchmark(config, {
    outputDir: outputDir ? path.resolve(outputDir) : undefined,
    sampleResource: runner.sampleResource,
    executeScenario: runner.runWorkload,
  });
  process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
  return result.summary.failed || result.summary.faulted ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "benchmark failed");
      process.exitCode = 1;
    });
}
