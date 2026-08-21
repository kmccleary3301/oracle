#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  evaluateCapabilityPromotionGate,
  writeDeterministicJson,
} from "../src/capabilities/capabilityDrift.js";

function readOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("-") ? value : undefined;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const inputPath =
    readOption(args, "--evidence") ??
    readOption(args, "--input") ??
    args.find((arg) => !arg.startsWith("-"));
  const outputPath = readOption(args, "--output");
  if (!inputPath) {
    process.stderr.write("promotion gate requires --evidence path\n");
    return 2;
  }
  let result;
  try {
    const value = JSON.parse(await readFile(path.resolve(inputPath), "utf8")) as unknown;
    result = evaluateCapabilityPromotionGate(value);
  } catch {
    result = evaluateCapabilityPromotionGate({ invalid: true });
  }
  const output = writeDeterministicJson(result);
  if (outputPath) await writeFile(outputPath, output, "utf8");
  else process.stdout.write(output);
  return result.passed ? 0 : 1;
}

process.exitCode = await main();
