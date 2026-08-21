#!/usr/bin/env node
import { createHash, sign as signPayload } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  hashReleaseEvidence,
  isRecord,
  releaseEvidenceSigningPayload,
  RELEASE_EVIDENCE_SCHEMA_VERSION,
  type JsonRecord,
} from "./release-evidence-core.js";
import {
  countConsecutiveQualifiedRuns,
  platformEvidenceQualifies,
  platformSoakQualifies,
} from "./release-evidence-soak.js";

export { countConsecutiveQualifiedRuns, platformEvidenceQualifies, platformSoakQualifies };

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
async function runPlatform(args: readonly string[]): Promise<void> {
  const platform = requiredOption(args, "--platform");
  if (!["macos", "linux", "windows"].includes(platform))
    throw new Error("--platform must be macos, linux, or windows");
  const resourcePath = requiredOption(args, "--resource");
  const resourceBaseline = await json(resourcePath);
  const soak = await json(requiredOption(args, "--soak"));
  const faultChaos = await json(requiredOption(args, "--fault"));
  const lane = option(args, "--lane") ?? "matrix";
  const observedDurationMs =
    isRecord(soak) && isRecord(soak.promotionGate)
      ? Number(soak.promotionGate.observedDurationMs ?? 0)
      : 0;
  const qualifies = lane === "matrix" && platformEvidenceQualifies(soak, observedDurationMs);
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
        observedDurationMs,
      },
      args,
    ),
  );
}

async function runSoak(args: readonly string[]): Promise<void> {
  const platform = requiredOption(args, "--platform");
  if (!["macos", "linux", "windows"].includes(platform))
    throw new Error("--platform must be macos, linux, or windows");
  const soakPath = requiredOption(args, "--soak");
  const soak = await json(soakPath);
  const lane = option(args, "--lane") ?? "smoke";
  const requiredDurationMs = Number(option(args, "--required-duration-ms") ?? 8 * 60 * 60 * 1_000);
  const observedDurationMs =
    isRecord(soak) && isRecord(soak.promotionGate)
      ? Number(soak.promotionGate.observedDurationMs ?? 0)
      : 0;
  const qualifies =
    platform === "macos" &&
    platformSoakQualifies(soak, lane, observedDurationMs, requiredDurationMs);
  const artifactDigest = (
    option(args, "--artifact-digest") ??
    process.env.RELEASE_ARTIFACT_DIGEST?.trim() ??
    (await sha256File(soakPath))
  ).replace(/^sha256:/i, "");
  const source = sourceFor(platform, artifactDigest, soakPath, args);
  await writeOutput(
    requiredOption(args, "--output"),
    await signed(
      {
        schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
        kind: "release-soak-evidence",
        platform,
        status: qualifies ? "claimed" : "unclaimed",
        qualified: qualifies,
        generatedAt: new Date().toISOString(),
        source,
        provenance: { ...source },
        soak,
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
  if (paths.length === 0) throw new Error("--manifest requires evidence manifests");
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
    if (value.kind === "release-platform-evidence") {
      const platform = String(value.platform ?? provenance.platform);
      if ((group.platforms as JsonRecord)[platform] !== undefined)
        throw new Error(`duplicate platform manifest for run ${runId} and ${platform}`);
      (group.platforms as JsonRecord)[platform] = value;
    } else if (value.kind === "release-soak-evidence") {
      if (group.soak !== undefined) throw new Error(`duplicate soak manifest for run ${runId}`);
      group.soak = value;
    }
    groups.set(runId, group);
  }
  const runs = [...groups.values()]
    .sort((left, right) => Number(left.runNumber) - Number(right.runNumber))
    .map((run) => {
      const platforms = isRecord(run.platforms) ? run.platforms : {};
      const platformQualified = ["macos", "linux", "windows"].every((platform) => {
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
          manifest.lane === "matrix" &&
          platformEvidenceQualifies(soak, observed)
        );
      });
      const soakManifest = isRecord(run.soak) ? run.soak : null;
      const soakArtifact = soakManifest?.soak;
      const observedDurationMs = Number(soakManifest?.observedDurationMs ?? 0);
      const soakQualified =
        soakManifest?.platform === "macos" &&
        soakManifest.status === "claimed" &&
        soakManifest.qualified === true &&
        platformSoakQualifies(soakArtifact, String(soakManifest.lane ?? ""), observedDurationMs);
      const qualified = platformQualified && soakQualified;
      return {
        ...run,
        status: qualified ? "claimed" : "unclaimed",
        qualified,
        observedDurationMs,
        durationMs: observedDurationMs,
      };
    });
  const consecutiveQualifiedRuns = countConsecutiveQualifiedRuns(runs);
  const artifactDigest = createHash("sha256").update(JSON.stringify(runs)).digest("hex");
  const source = sourceFor("all", artifactDigest, "release-runs.aggregate.json", args);
  await writeOutput(
    requiredOption(args, "--output"),
    await signed(
      {
        schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
        kind: "resource-soak-promotion-evidence",
        status: consecutiveQualifiedRuns >= 3 ? "claimed" : "unclaimed",
        qualified: consecutiveQualifiedRuns >= 3,
        consecutiveQualifiedRuns,
        generatedAt: new Date().toISOString(),
        source,
        provenance: { ...source },
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
  else if (command === "soak") await runSoak(args.slice(1));
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
