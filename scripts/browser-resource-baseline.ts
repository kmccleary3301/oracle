import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launch } from "chrome-launcher";
import {
  redactProcessTreeSample,
  sampleOwnedChromeTree,
  type ProcessTreeSample,
} from "../src/browser/resourceTelemetry.js";

interface BaselineOptions {
  outputPath: string;
  sampleCount: number;
  sampleIntervalMs: number;
  chromePath?: string;
}

interface TargetSummary {
  count: number;
  types: Record<string, number>;
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value?.trim()) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseOptions(args: readonly string[]): BaselineOptions {
  let outputPath = path.resolve(
    ".oracle-benchmarks",
    `${process.platform}-${process.arch}-chrome-baseline.json`,
  );
  let sampleCount = 5;
  let sampleIntervalMs = 1_000;
  let chromePath = process.env.CHROME_PATH?.trim() || undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--output") outputPath = path.resolve(requireValue(flag, value));
    else if (flag === "--samples") sampleCount = parsePositiveInteger(value, "--samples");
    else if (flag === "--interval-ms") {
      sampleIntervalMs = parsePositiveInteger(value, "--interval-ms");
    } else if (flag === "--chrome-path") chromePath = requireValue(flag, value);
    else throw new Error(`Unknown argument: ${flag}`);
    index += 1;
  }
  return { outputPath, sampleCount, sampleIntervalMs, chromePath };
}

async function readTargetSummary(port: number): Promise<TargetSummary> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`Chrome target inventory failed with HTTP ${response.status}.`);
  const targets = (await response.json()) as Array<{ type?: unknown }>;
  const types: Record<string, number> = {};
  for (const target of targets) {
    const type = typeof target.type === "string" && target.type ? target.type : "unknown";
    types[type] = (types[type] ?? 0) + 1;
  }
  return { count: targets.length, types };
}

function withoutProcesses(sample: ProcessTreeSample): Omit<ProcessTreeSample, "processes"> {
  const { processes: _processes, ...summary } = sample;
  return summary;
}

async function run(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-resource-baseline-"));
  const chrome = await launch({
    chromePath: options.chromePath,
    userDataDir: profileDir,
    chromeFlags: [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      ...(typeof process.getuid === "function" && process.getuid() === 0 ? ["--no-sandbox"] : []),
    ],
  });
  const samples: Array<Omit<ProcessTreeSample, "processes">> = [];
  let cleanup: Omit<ProcessTreeSample, "processes"> | undefined;
  try {
    await delay(1_000);
    for (let index = 0; index < options.sampleCount; index += 1) {
      const targets = await readTargetSummary(chrome.port);
      samples.push(
        withoutProcesses(
          redactProcessTreeSample(
            await sampleOwnedChromeTree({
              rootPid: chrome.pid,
              targetCount: targets.count,
              targetTypes: targets.types,
            }),
          ),
        ),
      );
      if (index + 1 < options.sampleCount) await delay(options.sampleIntervalMs);
    }
  } finally {
    try {
      await chrome.kill();
    } catch {
      // The process-tree probe below is the authoritative cleanup check.
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      cleanup = withoutProcesses(
        redactProcessTreeSample(
          await sampleOwnedChromeTree({ rootPid: chrome.pid, targetCount: 0, targetTypes: {} }),
        ),
      );
      if (!cleanup.rootFound) break;
      await delay(100);
    }
    await rm(profileDir, { recursive: true, force: true });
  }
  if (!cleanup || cleanup.rootFound) {
    throw new Error(`Chrome process tree ${chrome.pid} remained after bounded cleanup.`);
  }
  const rssValues = samples.map((sample) => sample.rssBytes);
  const artifact = {
    schemaVersion: 1,
    platform: process.platform,
    architecture: process.arch,
    workload: "isolated-headless-about-blank",
    sampleCount: samples.length,
    sampleIntervalMs: options.sampleIntervalMs,
    rssBytes: {
      min: Math.min(...rssValues),
      max: Math.max(...rssValues),
      mean: rssValues.reduce((sum, value) => sum + value, 0) / rssValues.length,
    },
    samples,
    cleanup,
  };
  await mkdir(path.dirname(options.outputPath), { recursive: true, mode: 0o700 });
  await writeFile(options.outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
