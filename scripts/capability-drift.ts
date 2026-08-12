#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildCapabilityDriftAlert,
  buildCapabilityLedger,
  compareCapabilityBaselines,
  writeDeterministicJson,
  type CapabilityLedgerInput,
  type CapabilityPlatform,
} from "../src/capabilities/capabilityDrift.js";

interface CliOptions {
  command: "compare" | "ledger";
  baseline?: string;
  current?: string;
  inputs: string[];
  platform?: CapabilityPlatform;
  output?: string;
}

function parseOptions(args: readonly string[]): CliOptions {
  const command = args[0] === "ledger" ? "ledger" : "compare";
  const options: CliOptions = { command, inputs: [] };
  for (let index = command === args[0] ? 1 : 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--baseline") options.baseline = value;
    else if (argument === "--current") options.current = value;
    else if (argument === "--input") {
      if (value) options.inputs.push(value);
      index += 1;
    } else if (argument === "--platform") {
      if (value === "macos" || value === "linux" || value === "windows" || value === "unknown") {
        options.platform = value;
      }
      index += 1;
    } else if (argument === "--output") {
      options.output = value;
      index += 1;
    } else if (!argument.startsWith("-")) options.inputs.push(argument);
  }
  return options;
}

async function readProbe(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    throw new Error("unable to read capability evidence");
  }
}

async function writeResult(output: string, outputPath: string | undefined): Promise<void> {
  if (outputPath) {
    await writeFile(outputPath, output, "utf8");
    return;
  }
  process.stdout.write(output);
}

async function run(options: CliOptions): Promise<number> {
  if (options.command === "compare") {
    if (!options.baseline || !options.current) {
      process.stderr.write("compare requires --baseline and --current\n");
      return 2;
    }
    const baseline = await readProbe(path.resolve(options.baseline));
    const current = await readProbe(path.resolve(options.current));
    const comparison = compareCapabilityBaselines(baseline, current);
    const alert = buildCapabilityDriftAlert(comparison);
    await writeResult(writeDeterministicJson(alert), options.output);
    return comparison.materialRegression ? 1 : 0;
  }

  if (options.inputs.length === 0) {
    process.stderr.write("ledger requires at least one --input path\n");
    return 2;
  }
  const inputs: CapabilityLedgerInput[] = [];
  for (const inputPath of options.inputs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.resolve(inputPath), "utf8")) as unknown;
    } catch {
      throw new Error("unable to read capability evidence");
    }
    const wrapper =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    const probe = wrapper?.probe ?? parsed;
    const platform =
      options.platform ?? (wrapper?.platform as CapabilityPlatform | undefined) ?? "unknown";
    inputs.push({ probe, platform, sourcePath: inputPath });
  }
  const ledger = buildCapabilityLedger(inputs);
  await writeResult(writeDeterministicJson(ledger), options.output);
  return 0;
}

const options = parseOptions(process.argv.slice(2));
try {
  process.exitCode = await run(options);
} catch {
  process.stderr.write("capability evidence command failed\n");
  process.exitCode = 2;
}
