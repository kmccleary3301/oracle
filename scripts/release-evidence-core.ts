import { createHash } from "node:crypto";

export const RELEASE_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const REQUIRED_PLATFORMS = ["macos", "linux", "windows"] as const;
export const DEFAULT_REQUIRED_SOAK_RUNS = 3;
export const DEFAULT_REQUIRED_SOAK_DURATION_MS = 8 * 60 * 60 * 1_000;
export const DEFAULT_MAX_AGE_MS = 48 * 60 * 60 * 1_000;
export const DEFAULT_MAX_PROMOTION_RSS_SLOPE_BYTES_PER_SECOND = (64 * 1024 * 1024) / (60 * 60);
export const PROMOTION_RSS_SLOPE_METHOD = "endpoint-delta-over-sample-span";
export const PROMOTION_RSS_NOISE_METHOD = "sample-range";
export const MAXIMUM_SOAK_SAMPLE_GAP_MS = 15_000;

export type RequiredPlatform = (typeof REQUIRED_PLATFORMS)[number];
export type TrustedProvenanceKeys = Readonly<Record<string, string>> | readonly string[] | string;
export type JsonRecord = Record<string, unknown>;

export interface ReleasePromotionGateOptions {
  nowMs?: number;
  maxAgeMs?: number;
  requiredSoakRuns?: number;
  requiredSoakDurationMs?: number;
  expectedRepository?: string;
  expectedWorkflow?: string;
  expectedRunId?: string;
  expectedSupplementalRunId?: string;
  expectedCommitSha?: string;
  expectedSourceRef?: string;
  trustedPublicKeys?: TrustedProvenanceKeys;
  trustedPublicKey?: string;
}

export interface ReleasePromotionGateResult {
  schemaVersion: typeof RELEASE_EVIDENCE_SCHEMA_VERSION;
  kind: "release-promotion-gate";
  passed: boolean;
  reasonCodes: string[];
  evidence: {
    requiredPlatforms: readonly RequiredPlatform[];
    observedPlatforms: string[];
    requiredSoakRuns: number;
    qualifiedSoakRuns: number;
    requiredSoakDurationMs: number;
    rollbackProof: boolean;
    capabilityDriftPassed: boolean;
  };
}

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
export function positiveInteger(value: unknown, fallback: number): number {
  const number = numberValue(value);
  return number !== null && Number.isInteger(number) && number > 0 ? number : fallback;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? "null";
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}
const ENVELOPE_HASH_KEYS = new Set(["sha256", "hash", "manifestSha256", "artifactSha256"]);
function unsignedValue(value: unknown, insideProvenance = false): unknown {
  if (Array.isArray(value)) return value.map((entry) => unsignedValue(entry, insideProvenance));
  if (!isRecord(value)) return value;
  const result: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    if (ENVELOPE_HASH_KEYS.has(key) || (insideProvenance && key === "signature")) continue;
    result[key] = unsignedValue(entry, insideProvenance || key === "provenance");
  }
  return result;
}
export function releaseEvidenceSigningPayload(value: unknown): string {
  return stableJson(unsignedValue(value));
}
export function hashReleaseEvidence(value: unknown): string {
  return createHash("sha256").update(releaseEvidenceSigningPayload(value)).digest("hex");
}
export function readHash(value: JsonRecord): string | null {
  return (
    stringValue(value.sha256) ??
    stringValue(value.hash) ??
    stringValue(value.manifestSha256) ??
    stringValue(value.artifactSha256)
  );
}
export function sourceValue(value: unknown): { valid: boolean; commitSha: string | null } {
  if (typeof value === "string") {
    const source = value.trim();
    return {
      valid: source.length > 0 && !/^(unknown|unclaimed|synthetic|local|fixture)$/i.test(source),
      commitSha: null,
    };
  }
  if (!isRecord(value)) return { valid: false, commitSha: null };
  const pathValue =
    stringValue(value.artifactPath) ??
    stringValue(value.path) ??
    stringValue(value.workflow) ??
    stringValue(value.name);
  const commitSha = stringValue(value.commitSha) ?? stringValue(value.sha);
  return {
    valid:
      Boolean(pathValue) && !/^(unknown|unclaimed|synthetic|local|fixture)$/i.test(pathValue ?? ""),
    commitSha,
  };
}
export function generatedAt(value: JsonRecord): number | null {
  const candidate = value.generatedAt ?? value.capturedAt ?? value.observedAt ?? value.createdAt;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === "string") {
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
export function claimStatus(value: JsonRecord): string | null {
  const nested = isRecord(value.promotionGate) ? value.promotionGate : null;
  return (
    stringValue(value.claimStatus) ??
    stringValue(value.status) ??
    stringValue(nested?.claimStatus) ??
    stringValue(nested?.status)
  );
}
export function isClaimed(value: JsonRecord): boolean {
  const status = claimStatus(value);
  return status === "claimed" || status === "qualified";
}
export function provenanceValue(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const provenance = value.provenance ?? value.attestedProvenance;
  return isRecord(provenance) ? provenance : null;
}
export function claim(value: JsonRecord, ...names: string[]): string | null {
  for (const name of names) {
    const result = stringValue(value[name]);
    if (result) return result;
  }
  return null;
}
