#!/usr/bin/env node
import { createHash, sign as signPayload } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  hashReleaseEvidence,
  releaseEvidenceSigningPayload,
  RELEASE_EVIDENCE_SCHEMA_VERSION,
} from "./release-promotion-gate.js";

type JsonRecord = Record<string, unknown>;
function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  return value && !value.startsWith("-") ? value : undefined;
}
function options(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1)
    if (args[index] === name && args[index + 1] && !args[index + 1].startsWith("-"))
      values.push(args[index + 1]);
  return values;
}
function requiredOption(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}
async function json(pathName: string): Promise<unknown> {
  return JSON.parse(await readFile(path.resolve(pathName), "utf8")) as unknown;
}
async function sha256File(pathName: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path.resolve(pathName)))
    .digest("hex");
}
function sourceFor(
  platform: string,
  sourceArtifactDigest: string,
  sourceArtifactPath: string,
  args: readonly string[],
): JsonRecord {
  const repository = option(args, "--repository") ?? process.env.GITHUB_REPOSITORY?.trim();
  const workflow = option(args, "--workflow") ?? process.env.GITHUB_WORKFLOW?.trim();
  const runId = option(args, "--run-id") ?? process.env.GITHUB_RUN_ID?.trim();
  const runNumber = option(args, "--run-number") ?? process.env.GITHUB_RUN_NUMBER?.trim();
  const commitSha = option(args, "--commit") ?? process.env.GITHUB_SHA?.trim();
  const sourceRef = option(args, "--source-ref") ?? process.env.GITHUB_REF?.trim();
  return {
    workflow,
    runId,
    runNumber: Number(runNumber),
    commitSha,
    sourceRef,
    repository,
    generatedAt: new Date().toISOString(),
    sourceArtifactDigest: `sha256:${sourceArtifactDigest.replace(/^sha256:/i, "")}`,
    platform,
    artifactPath: `release-evidence/${path.basename(sourceArtifactPath)}`,
    subjectPath: path.basename(requiredOption(args, "--output")),
  };
}
async function signed(value: JsonRecord, args: readonly string[]): Promise<JsonRecord> {
  const privateKeyOption =
    option(args, "--private-key") ?? process.env.RELEASE_PROVENANCE_PRIVATE_KEY;
  let privateKey = privateKeyOption;
  if (privateKeyOption && !privateKeyOption.includes("BEGIN")) {
    try {
      privateKey = await readFile(path.resolve(privateKeyOption), "utf8");
    } catch {
      privateKey = privateKeyOption;
    }
  }
  const unsigned = { ...value };
  if (privateKey) {
    const provenance = unsigned.provenance;
    if (!isRecord(provenance)) throw new Error("provenance is required before signing");
    unsigned.provenance = {
      ...provenance,
      signature: {
        algorithm: "ed25519",
        keyId: option(args, "--key-id") ?? process.env.RELEASE_PROVENANCE_KEY_ID ?? "default",
        signature: signPayload(
          null,
          Buffer.from(releaseEvidenceSigningPayload(unsigned), "utf8"),
          privateKey,
        ).toString("base64url"),
      },
    };
  }
  return { ...unsigned, sha256: hashReleaseEvidence(unsigned) };
}
async function writeOutput(outputPath: string, value: unknown): Promise<void> {
  await writeFile(path.resolve(outputPath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function soakQualifies(
  soak: unknown,
  lane: string,
  observedDurationMs: number,
  requiredDurationMs: number,
): boolean {
  if (!isRecord(soak)) return false;
  const chrome = isRecord(soak.chrome) ? soak.chrome : null;
  const cleanup = isRecord(soak.cleanup) ? soak.cleanup : null;
  const orphans = isRecord(soak.orphans) ? soak.orphans : null;
  const samples = Array.isArray(soak.samples) ? soak.samples : [];
  const cycles = orphans && Array.isArray(orphans.cycles) ? orphans.cycles : [];
  return (
    lane === "promotion" &&
    soak.realProcessSampling === true &&
    chrome?.isolated === true &&
    chrome.headless === true &&
    Number(chrome.rootFoundSamples) > 0 &&
    Number(chrome.nonzeroProcessSamples) > 0 &&
    chrome.cleanupConfirmed === true &&
    cleanup?.rootFound === false &&
    cleanup.processCount === 0 &&
    orphans?.samplesWithActiveTargets === 0 &&
    orphans.maxActiveTargetsAfterRelease === 0 &&
    cycles.length > 0 &&
    cycles.every((cycle) => isRecord(cycle) && cycle.baselineRestored === true) &&
    samples.length > 0 &&
    samples.every(
      (sample) =>
        isRecord(sample) &&
        sample.rootFound === true &&
        Number(sample.processCount) > 0 &&
        Number(sample.rssBytes) > 0,
    ) &&
    observedDurationMs >= requiredDurationMs
  );
}
export function platformSoakQualifies(
  soak: unknown,
  lane: string,
  observedDurationMs: number,
  requiredDurationMs = 8 * 60 * 60 * 1_000,
): boolean {
  return soakQualifies(soak, lane, observedDurationMs, requiredDurationMs);
}
async function runPlatform(args: readonly string[]): Promise<void> {
  const platform = requiredOption(args, "--platform");
  if (!["macos", "linux", "windows"].includes(platform))
    throw new Error("--platform must be macos, linux, or windows");
  const resourcePath = requiredOption(args, "--resource");
  const resourceBaseline = await json(resourcePath);
  const soak = await json(requiredOption(args, "--soak"));
  const faultChaos = await json(requiredOption(args, "--fault"));
  const lane = option(args, "--lane") ?? "smoke";
  const requiredDurationMs = Number(option(args, "--required-duration-ms") ?? 8 * 60 * 60 * 1_000);
  const observedDurationMs =
    isRecord(soak) && isRecord(soak.promotionGate)
      ? Number(soak.promotionGate.observedDurationMs ?? 0)
      : 0;
  const qualifies = platformSoakQualifies(soak, lane, observedDurationMs, requiredDurationMs);
  const artifactDigest = (
    option(args, "--artifact-digest") ??
    process.env.RELEASE_ARTIFACT_DIGEST?.trim() ??
    (await sha256File(resourcePath))
  ).replace(/^sha256:/i, "");
  const source = sourceFor(platform, artifactDigest, resourcePath, args);
  const provenance = { ...source };
  await writeOutput(
    requiredOption(args, "--output"),
    await signed(
      {
        schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
        kind: "release-platform-evidence",
        platform,
        status: qualifies ? "claimed" : "unclaimed",
        qualified: qualifies,
        generatedAt: new Date().toISOString(),
        source,
        provenance,
        resourceBaseline,
        soak,
        faultChaos,
        lane,
        requiredDurationMs,
        observedDurationMs,
      },
      args,
    ),
  );
}
async function runAggregate(args: readonly string[]): Promise<void> {
  const paths = options(args, "--manifest");
  if (paths.length === 0) throw new Error("--manifest requires at least one platform manifest");
  const loaded = await Promise.all(paths.map((manifestPath) => json(manifestPath)));
  const groups = new Map<string, JsonRecord>();
  for (const value of loaded) {
    if (!isRecord(value)) continue;
    const provenance = isRecord(value.provenance) ? value.provenance : {};
    const runId = String(provenance.runId ?? "");
    if (!runId) continue;
    const group = groups.get(runId) ?? {
      runId,
      runNumber: provenance.runNumber,
      commitSha: provenance.commitSha,
      generatedAt: provenance.generatedAt,
      sequence: provenance.runNumber,
      provenance: { ...provenance, platform: "all" },
      platforms: {},
    };
    (group.platforms as JsonRecord)[String(value.platform ?? provenance.platform)] = value;
    groups.set(runId, group);
  }
  const runs = [...groups.values()]
    .sort((left, right) => Number(left.runNumber) - Number(right.runNumber))
    .map((run) => {
      const platforms = isRecord(run.platforms) ? run.platforms : {};
      const qualified = ["macos", "linux", "windows"].every((platform) => {
        const manifest = platforms[platform];
        if (!isRecord(manifest)) return false;
        const soak = manifest.soak;
        const observed = Number(
          manifest.observedDurationMs ??
            (isRecord(soak) && isRecord(soak.promotionGate)
              ? soak.promotionGate.observedDurationMs
              : 0),
        );
        return (
          manifest.status === "claimed" &&
          manifest.qualified === true &&
          platformSoakQualifies(soak, "promotion", observed)
        );
      });
      return { ...run, status: qualified ? "claimed" : "unclaimed", qualified };
    });
  const artifactDigest = createHash("sha256").update(JSON.stringify(runs)).digest("hex");
  const source = sourceFor("all", artifactDigest, "platform-runs.aggregate.json", args);
  const provenance = { ...source };
  await writeOutput(
    requiredOption(args, "--output"),
    await signed(
      {
        schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
        kind: "resource-soak-promotion-evidence",
        status: runs.filter((run) => run.qualified).length >= 3 ? "claimed" : "unclaimed",
        qualified: runs.filter((run) => run.qualified).length >= 3,
        generatedAt: new Date().toISOString(),
        source,
        provenance,
        runs,
      },
      args,
    ),
  );
}
async function runWrapper(
  kind: "capability" | "review" | "rollback",
  args: readonly string[],
): Promise<void> {
  const inputPath = requiredOption(args, "--input");
  const value = await json(inputPath);
  if (!isRecord(value)) throw new Error(`${kind} input must be a JSON object`);
  const digest = await sha256File(inputPath);
  const source = sourceFor("all", digest, inputPath, args);
  const provenance = { ...source };
  const claimed = value.status === "claimed" && (value.passed === true || value.approved === true);
  const manifestKind =
    kind === "capability"
      ? "chatgpt-capability-promotion-gate"
      : kind === "review"
        ? "authenticated-review-evidence"
        : "packaged-rollback-proof";
  await writeOutput(
    requiredOption(args, "--output"),
    await signed(
      {
        ...value,
        schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
        kind: manifestKind,
        status: claimed ? "claimed" : "unclaimed",
        generatedAt: value.generatedAt ?? new Date().toISOString(),
        source,
        provenance,
      },
      args,
    ),
  );
}
async function main(args = process.argv.slice(2)): Promise<number> {
  const command = args[0] ?? "platform";
  if (command === "platform") await runPlatform(args.slice(1));
  else if (command === "aggregate") await runAggregate(args.slice(1));
  else if (command === "capability" || command === "review" || command === "rollback")
    await runWrapper(command, args.slice(1));
  else {
    process.stderr.write(
      "usage: release-evidence-manifest.ts platform|aggregate|capability|review|rollback ...\n",
    );
    return 2;
  }
  return 0;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
