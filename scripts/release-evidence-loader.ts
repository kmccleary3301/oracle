import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  RELEASE_EVIDENCE_SCHEMA_VERSION,
  REQUIRED_PLATFORMS,
  isRecord,
  provenanceValue,
  stringValue,
  type JsonRecord,
  type RequiredPlatform,
} from "./release-evidence-core.js";

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}
async function allJsonFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await allJsonFiles(child)));
    else if (entry.isFile() && entry.name.endsWith(".json")) result.push(child);
  }
  return result;
}
function basenamePlatform(name: string): RequiredPlatform | null {
  for (const platform of REQUIRED_PLATFORMS)
    if (name === `platform-${platform}.json`) return platform;
  return null;
}
export async function loadReleaseEvidenceDirectory(directory: string): Promise<JsonRecord> {
  const root = path.resolve(directory);
  const files = await allJsonFiles(root);
  const byName = new Map<string, string>();
  for (const file of files) byName.set(file, file);
  const manifests: JsonRecord = { platforms: {} };
  const attestations: JsonRecord = {};
  const groups = new Map<string, JsonRecord>();
  for (const file of files) {
    const name = path.basename(file);
    const platform = basenamePlatform(name);
    if (!platform) continue;
    const value = await readJson(file);
    const provenance = provenanceValue(value);
    const runId =
      stringValue(provenance?.runId) ??
      path.basename(path.dirname(file)).match(/(?:run-|nightly-)?(\d+)/)?.[1] ??
      "";
    const group = groups.get(runId) ?? {
      runId,
      runNumber: provenance?.runNumber,
      commitSha: provenance?.commitSha,
      generatedAt: provenance?.generatedAt,
      sequence: provenance?.runNumber,
      platforms: {},
      attestations: {},
    };
    if ((group.platforms as JsonRecord)[platform] !== undefined)
      throw new Error(`duplicate platform manifest for run ${runId} and ${platform}`);
    (group.platforms as JsonRecord)[platform] = value;
    const attestationPath = path.join(path.dirname(file), `attestation-platform-${platform}.json`);
    if (byName.has(attestationPath))
      (group.attestations as JsonRecord)[platform] = await readJson(attestationPath);
    groups.set(runId, group);
    (manifests.platforms as JsonRecord)[platform] = value;
  }
  for (const file of files) {
    if (path.basename(file) !== "soak-evidence.json") continue;
    const value = await readJson(file);
    const provenance = provenanceValue(value);
    const runId =
      stringValue(provenance?.runId) ??
      path.basename(path.dirname(file)).match(/(?:run-|nightly-)?(\d+)/)?.[1] ??
      "";
    const group = groups.get(runId) ?? {
      runId,
      runNumber: provenance?.runNumber,
      commitSha: provenance?.commitSha,
      generatedAt: provenance?.generatedAt,
      sequence: provenance?.runNumber,
      platforms: {},
      attestations: {},
    };
    if (group.soak !== undefined) throw new Error(`duplicate soak manifest for run ${runId}`);
    group.soak = value;
    const attestationPath = path.join(path.dirname(file), "attestation-soak.json");
    if (byName.has(attestationPath))
      (group.attestations as JsonRecord).soak = await readJson(attestationPath);
    groups.set(runId, group);
  }
  for (const file of files) {
    const name = path.basename(file);
    const value = await readJson(file);
    if (name === "capability.json" || name === "capability-manifest.json")
      manifests.capability = value;
    else if (name === "review.json" || name === "review-evidence.json") manifests.review = value;
    else if (name === "soak.json" || name === "resource-soak.json" || name === "soak-manifest.json")
      manifests.soak = value;
    else if (
      name === "rollback.json" ||
      name === "packaged-rollback.json" ||
      name === "rollback-manifest.json"
    )
      manifests.rollback = value;
    else if (name === "attestation-all.json" || name === "attestation.json")
      attestations.all = value;
  }
  const platformRuns: JsonRecord[] = [];
  for (const group of groups.values()) {
    let metadata: JsonRecord = {};
    const metadataPath = path.join(root, "runs", `run-${group.runId}`, "run-metadata.json");
    if (byName.has(metadataPath)) {
      const loaded = await readJson(metadataPath);
      if (isRecord(loaded)) metadata = loaded;
    }
    platformRuns.push({
      ...group,
      ...metadata,
      platforms: group.platforms,
      soak: group.soak,
      attestations: group.attestations,
    });
  }
  if (platformRuns.length > 0) manifests.platformRuns = platformRuns;
  return { schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION, manifests, attestations };
}
