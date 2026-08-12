#!/usr/bin/env node
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const REQUIRED_PLATFORMS = ["macos", "linux", "windows"] as const;
export const DEFAULT_REQUIRED_SOAK_RUNS = 3;
export const DEFAULT_REQUIRED_SOAK_DURATION_MS = 8 * 60 * 60 * 1_000;
export const DEFAULT_MAX_AGE_MS = 48 * 60 * 60 * 1_000;

export type RequiredPlatform = (typeof REQUIRED_PLATFORMS)[number];
export type TrustedProvenanceKeys = Readonly<Record<string, string>> | readonly string[] | string;
type JsonRecord = Record<string, unknown>;

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
function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function positiveInteger(value: unknown, fallback: number): number {
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
function readHash(value: JsonRecord): string | null {
  return (
    stringValue(value.sha256) ??
    stringValue(value.hash) ??
    stringValue(value.manifestSha256) ??
    stringValue(value.artifactSha256)
  );
}
function sourceValue(value: unknown): { valid: boolean; commitSha: string | null } {
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
function generatedAt(value: JsonRecord): number | null {
  const candidate = value.generatedAt ?? value.capturedAt ?? value.observedAt ?? value.createdAt;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === "string") {
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
function claimStatus(value: JsonRecord): string | null {
  const nested = isRecord(value.promotionGate) ? value.promotionGate : null;
  return (
    stringValue(value.claimStatus) ??
    stringValue(value.status) ??
    stringValue(nested?.claimStatus) ??
    stringValue(nested?.status)
  );
}
function isClaimed(value: JsonRecord): boolean {
  const status = claimStatus(value);
  return status === "claimed" || status === "qualified";
}
function provenanceValue(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const provenance = value.provenance ?? value.attestedProvenance;
  return isRecord(provenance) ? provenance : null;
}
function decodeBytes(value: unknown): Buffer | null {
  const encoded = stringValue(value);
  if (!encoded) return null;
  try {
    if (/^[a-f0-9]{128}$/i.test(encoded)) return Buffer.from(encoded, "hex");
    const bytes = Buffer.from(encoded, "base64url");
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}
function trustedKeyMap(options: Required<ReleasePromotionGateOptions>): Map<string, string> {
  const configured = options.trustedPublicKeys ?? options.trustedPublicKey;
  if (!configured) return new Map();
  if (typeof configured === "string") return new Map([["default", configured]]);
  if (Array.isArray(configured))
    return new Map(configured.map((key, index) => [String(index), key]));
  return new Map(Object.entries(configured));
}
function signatureValue(provenance: JsonRecord, value: JsonRecord): JsonRecord | null {
  const signature = provenance.signature ?? value.signature;
  return isRecord(signature) ? signature : null;
}
function attestationValue(
  provenance: JsonRecord,
  value: JsonRecord,
  external: unknown,
): JsonRecord | null {
  if (isRecord(external)) return external;
  const attestation = provenance.attestation ?? value.attestation;
  return isRecord(attestation) ? attestation : null;
}
function claim(value: JsonRecord, ...names: string[]): string | null {
  for (const name of names) {
    const result = stringValue(value[name]);
    if (result) return result;
  }
  return null;
}
function nestedClaim(value: unknown, names: readonly string[]): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = nestedClaim(entry, names);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const name of names) {
    const candidate = value[name];
    const found =
      stringValue(candidate) ??
      (typeof candidate === "number" && Number.isFinite(candidate) ? String(candidate) : null);
    if (found) return found;
    if (isRecord(candidate)) {
      const nested = stringValue(candidate.name);
      if (nested) return nested;
    }
  }
  for (const entry of Object.values(value)) {
    const found = nestedClaim(entry, names);
    if (found) return found;
  }
  return null;
}
function parsedVerificationResult(value: unknown): JsonRecord | null {
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (isRecord(entry.verificationResult)) return entry.verificationResult;
  }
  return null;
}
function normalizedSha256(value: unknown): string | null {
  const digest = stringValue(value);
  if (!digest) return null;
  return digest.startsWith("sha256:") ? digest : `sha256:${digest}`;
}
function attestationFacts(attestation: JsonRecord): JsonRecord | null {
  const verification = attestation.verification ?? attestation.rawVerification ?? attestation.raw;
  if (!verification || (isRecord(verification) && Object.keys(verification).length === 0))
    return null;
  const result = parsedVerificationResult(verification);
  if (result) {
    const signature = isRecord(result.signature) ? result.signature : null;
    const certificate = signature && isRecord(signature.certificate) ? signature.certificate : null;
    const extensions =
      certificate && isRecord(certificate.extensions) ? certificate.extensions : null;
    const statement = isRecord(result.statement) ? result.statement : null;
    const subjects = statement && Array.isArray(statement.subject) ? statement.subject : [];
    const subject = subjects.find(isRecord) ?? null;
    const digest = subject && isRecord(subject.digest) ? subject.digest : null;
    return {
      repository:
        stringValue(extensions?.sourceRepositoryIdentifier) ??
        stringValue(extensions?.sourceRepository),
      workflow:
        stringValue(extensions?.buildSignerURI) ?? stringValue(extensions?.githubWorkflowRef),
      runId:
        stringValue(extensions?.githubWorkflowRunID) ??
        (typeof extensions?.githubWorkflowRunID === "number"
          ? String(extensions.githubWorkflowRunID)
          : null),
      commitSha: stringValue(extensions?.sourceRepositoryDigest),
      sourceRef: stringValue(extensions?.sourceRepositoryRef),
      subjectPath: stringValue(subject?.name),
      artifactDigest: normalizedSha256(digest?.sha256),
      issuer: stringValue(extensions?.oidcIssuer),
    };
  }
  return {
    repository: nestedClaim(verification, [
      "sourceRepositoryIdentifier",
      "sourceRepository",
      "repository",
      "repo",
    ]),
    workflow: nestedClaim(verification, [
      "buildSignerURI",
      "githubWorkflowRef",
      "signerWorkflow",
      "workflow",
      "workflowName",
      "workflowRef",
    ]),
    runId: nestedClaim(verification, ["githubWorkflowRunID", "runId", "run_id", "workflowRunId"]),
    commitSha: nestedClaim(verification, [
      "sourceRepositoryDigest",
      "commitSha",
      "sourceCommit",
      "commit",
    ]),
    sourceRef: nestedClaim(verification, ["sourceRepositoryRef", "sourceRef", "source_ref", "ref"]),
    subjectPath: nestedClaim(verification, ["subjectPath", "subject", "name", "artifactPath"]),
    artifactDigest: normalizedSha256(
      nestedClaim(verification, ["artifactDigest", "subjectDigest", "digest", "sha256"]),
    ),
    issuer: nestedClaim(verification, ["issuer", "certificateIssuer", "issuerUrl"]),
  };
}
function validAttestation(
  attestation: JsonRecord | null,
  provenance: JsonRecord,
  options: Required<ReleasePromotionGateOptions>,
  reasonPrefix: string,
  reasons: string[],
): boolean {
  const before = reasons.length;
  if (!attestation || attestation.verified !== true) {
    reasons.push(`${reasonPrefix}_attestation_invalid`);
    return false;
  }
  const facts = attestationFacts(attestation);
  if (!facts) {
    reasons.push(`${reasonPrefix}_attestation_untrusted`);
    return false;
  }
  const pinned = isRecord(attestation.pinned) ? attestation.pinned : null;
  const actualRepository = claim(pinned ?? {}, "repository") ?? stringValue(facts.repository);
  const actualWorkflow =
    claim(pinned ?? {}, "signerWorkflow", "workflow") ?? stringValue(facts.workflow);
  const actualRunId = claim(pinned ?? {}, "runId") ?? stringValue(facts.runId);
  const actualCommit =
    claim(pinned ?? {}, "sourceCommit", "commitSha") ?? stringValue(facts.commitSha);
  const actualSourceRef = claim(pinned ?? {}, "sourceRef") ?? stringValue(facts.sourceRef);
  const expected: Array<[string, string | null, string | null]> = [
    ["repository", stringValue(provenance.repository), actualRepository],
    ["workflow", stringValue(provenance.workflow), actualWorkflow],
    ["run_id", stringValue(provenance.runId), actualRunId],
    ["commit", stringValue(provenance.commitSha), actualCommit],
  ];
  for (const [name, expectedValue, actual] of expected)
    if (!expectedValue || !actual || actual !== expectedValue)
      reasons.push(`${reasonPrefix}_attestation_${name}_mismatch`);
  const expectedRef = stringValue(provenance.sourceRef) ?? options.expectedSourceRef;
  if (expectedRef && actualSourceRef !== expectedRef)
    reasons.push(`${reasonPrefix}_attestation_source_ref_mismatch`);
  if (options.expectedRepository && actualRepository !== options.expectedRepository)
    reasons.push(`${reasonPrefix}_attestation_repository_mismatch`);
  if (options.expectedWorkflow && actualWorkflow !== options.expectedWorkflow)
    reasons.push(`${reasonPrefix}_attestation_workflow_mismatch`);
  if (options.expectedRunId && actualRunId !== options.expectedRunId)
    reasons.push(`${reasonPrefix}_attestation_run_mismatch`);
  if (options.expectedCommitSha && actualCommit !== options.expectedCommitSha)
    reasons.push(`${reasonPrefix}_attestation_commit_mismatch`);
  const expectedSubject = stringValue(provenance.subjectPath);
  const wrapperSubject = claim(attestation, "subjectPath", "subject");
  const rawSubject = stringValue(facts.subjectPath);
  if (
    !expectedSubject ||
    !wrapperSubject ||
    !rawSubject ||
    path.basename(wrapperSubject) !== path.basename(expectedSubject) ||
    path.basename(rawSubject) !== path.basename(expectedSubject)
  )
    reasons.push(`${reasonPrefix}_attestation_subject_mismatch`);
  const wrapperDigest = normalizedSha256(claim(attestation, "subjectDigest"));
  const rawDigest = normalizedSha256(facts.artifactDigest);
  if (!wrapperDigest || !rawDigest)
    reasons.push(`${reasonPrefix}_attestation_subject_digest_missing`);
  else if (wrapperDigest !== rawDigest)
    reasons.push(`${reasonPrefix}_attestation_subject_digest_mismatch`);
  if (facts.issuer && facts.issuer !== "https://token.actions.githubusercontent.com")
    reasons.push(`${reasonPrefix}_attestation_issuer_invalid`);
  return reasons.length === before;
}
function verifyPinnedSignature(
  signature: JsonRecord | null,
  value: JsonRecord,
  options: Required<ReleasePromotionGateOptions>,
  reasonPrefix: string,
  reasons: string[],
): boolean {
  const keys = trustedKeyMap(options);
  const before = reasons.length;
  if (!signature) {
    reasons.push(`${reasonPrefix}_signature_missing`);
    return false;
  }
  if (claim(signature, "algorithm", "alg")?.toLowerCase() !== "ed25519") {
    reasons.push(`${reasonPrefix}_signature_algorithm_invalid`);
    return false;
  }
  const keyId = claim(signature, "keyId", "kid") ?? (keys.size === 1 ? [...keys.keys()][0] : null);
  const publicKey = keyId ? keys.get(keyId) : undefined;
  if (!publicKey) {
    reasons.push(`${reasonPrefix}_signature_untrusted`);
    return false;
  }
  const bytes = decodeBytes(signature.signature ?? signature.value ?? signature.signatureBase64);
  if (!bytes) {
    reasons.push(`${reasonPrefix}_signature_invalid`);
    return false;
  }
  try {
    const key = createPublicKey(publicKey);
    if (
      !verifySignature(null, Buffer.from(releaseEvidenceSigningPayload(value), "utf8"), key, bytes)
    )
      reasons.push(`${reasonPrefix}_signature_invalid`);
  } catch {
    reasons.push(`${reasonPrefix}_signature_invalid`);
  }
  return reasons.length === before;
}
function hasValidEnvelope(
  value: unknown,
  reasonPrefix: string,
  reasons: string[],
  options: Required<ReleasePromotionGateOptions>,
  expectedPlatform?: string,
  externalAttestation?: unknown,
  allowSupplementalRun = false,
  derivedFromAuthenticatedPlatforms = false,
): boolean {
  const before = reasons.length;
  if (!isRecord(value)) {
    reasons.push(`${reasonPrefix}_manifest_invalid`);
    return false;
  }
  if (value.schemaVersion !== RELEASE_EVIDENCE_SCHEMA_VERSION)
    reasons.push(`${reasonPrefix}_schema_invalid`);
  const time = generatedAt(value);
  if (time === null) reasons.push(`${reasonPrefix}_timestamp_invalid`);
  else if (time > options.nowMs + 5 * 60 * 1_000) reasons.push(`${reasonPrefix}_timestamp_future`);
  else if (options.nowMs - time > options.maxAgeMs) reasons.push(`${reasonPrefix}_stale`);
  if (!sourceValue(value.source ?? value.sourcePath ?? value.artifactPath).valid)
    reasons.push(`${reasonPrefix}_source_invalid`);
  const provenance = provenanceValue(value);
  if (!provenance) reasons.push(`${reasonPrefix}_provenance_missing`);
  else {
    const requiredFields: Array<[string, string]> = [
      ["repository", "repository"],
      ["workflow", "workflow"],
      ["run_id", "runId"],
      ["commit", "commitSha"],
      ["source_artifact_digest", "sourceArtifactDigest"],
      ["platform", "platform"],
    ];
    if (expectedPlatform && expectedPlatform !== "all")
      requiredFields.push(["run_number", "runNumber"]);
    for (const [reasonName, field] of requiredFields)
      if (
        !stringValue(provenance[field]) &&
        !(field === "runNumber" && numberValue(provenance[field]) !== null)
      )
        reasons.push(`${reasonPrefix}_provenance_${reasonName}_missing`);
    if (!options.expectedRepository) reasons.push(`${reasonPrefix}_repository_required`);
    else if (stringValue(provenance.repository) !== options.expectedRepository)
      reasons.push(`${reasonPrefix}_repository_mismatch`);
    if (!options.expectedWorkflow) reasons.push(`${reasonPrefix}_workflow_required`);
    else if (stringValue(provenance.workflow) !== options.expectedWorkflow)
      reasons.push(`${reasonPrefix}_workflow_mismatch`);
    if (!options.expectedCommitSha) reasons.push(`${reasonPrefix}_commit_required`);
    else if (stringValue(provenance.commitSha) !== options.expectedCommitSha)
      reasons.push(`${reasonPrefix}_commit_mismatch`);
    const signature = signatureValue(provenance, value);
    const provenanceRunId = stringValue(provenance.runId);
    const runMatches =
      !options.expectedRunId ||
      provenanceRunId === options.expectedRunId ||
      (allowSupplementalRun &&
        Boolean(options.expectedSupplementalRunId) &&
        provenanceRunId === options.expectedSupplementalRunId);
    if (!runMatches) reasons.push(`${reasonPrefix}_run_mismatch`);
    if (
      options.expectedSourceRef &&
      stringValue(provenance.sourceRef) !== options.expectedSourceRef
    )
      reasons.push(`${reasonPrefix}_source_ref_mismatch`);
    const digest = stringValue(provenance.sourceArtifactDigest);
    if (digest && !/^sha256:[a-f0-9]{64}$/i.test(digest))
      reasons.push(`${reasonPrefix}_source_artifact_digest_invalid`);
    const platform = stringValue(provenance.platform);
    if (expectedPlatform && expectedPlatform !== "all" && platform !== expectedPlatform)
      reasons.push(`${reasonPrefix}_platform_mismatch`);
    if (stringValue(value.platform) && stringValue(value.platform) !== platform)
      reasons.push(`${reasonPrefix}_platform_mismatch`);
    if (!derivedFromAuthenticatedPlatforms) {
      if (signature) verifyPinnedSignature(signature, value, options, reasonPrefix, reasons);
      else
        validAttestation(
          attestationValue(provenance, value, externalAttestation),
          provenance,
          options,
          reasonPrefix,
          reasons,
        );
    }
  }
  const declaredHash = readHash(value);
  if (
    !declaredHash ||
    !/^[a-f0-9]{64}$/i.test(declaredHash) ||
    declaredHash.toLowerCase() !== hashReleaseEvidence(value)
  )
    reasons.push(`${reasonPrefix}_hash_invalid`);
  return reasons.length === before;
}
function nestedManifest(value: JsonRecord, ...names: string[]): unknown {
  for (const name of names) if (value[name] !== undefined) return value[name];
  return undefined;
}
function platformEntries(input: JsonRecord): Map<string, unknown> {
  const result = new Map<string, unknown>();
  const candidates = nestedManifest(
    input,
    "platforms",
    "resources",
    "resourceBaselines",
    "baselines",
  );
  if (isRecord(candidates))
    for (const [platform, value] of Object.entries(candidates))
      result.set(platform.toLowerCase(), value);
  const manifests = isRecord(input.manifests) ? input.manifests : null;
  const manifestPlatforms =
    manifests && (manifests.platforms ?? manifests.resources ?? manifests.baselines);
  if (isRecord(manifestPlatforms))
    for (const [platform, value] of Object.entries(manifestPlatforms))
      result.set(platform.toLowerCase(), value);
  return result;
}
function durationOf(value: JsonRecord): number | null {
  const soak = isRecord(value.soak) ? value.soak : null;
  const gate = soak && isRecord(soak.promotionGate) ? soak.promotionGate : null;
  return numberValue(value.observedDurationMs ?? gate?.observedDurationMs ?? soak?.durationMs);
}
function cleanCycles(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.samplesWithActiveTargets !== 0 ||
    value.maxActiveTargetsAfterRelease !== 0
  )
    return false;
  const cycles = value.cycles;
  return (
    Array.isArray(cycles) &&
    cycles.length > 0 &&
    cycles.every((cycle) => isRecord(cycle) && cycle.baselineRestored === true)
  );
}
function qualifiesPlatform(
  value: JsonRecord,
  options: Required<ReleasePromotionGateOptions>,
  reasons: string[],
  prefix: string,
): boolean {
  const soak = isRecord(value.soak) ? value.soak : null;
  const chrome = soak && isRecord(soak.chrome) ? soak.chrome : null;
  const cleanup = soak && isRecord(soak.cleanup) ? soak.cleanup : null;
  const orphans = soak && isRecord(soak.orphans) ? soak.orphans : null;
  const samples = soak && Array.isArray(soak.samples) ? soak.samples : [];
  const duration = durationOf(value);
  const valid =
    value.qualified === true &&
    isClaimed(value) &&
    value.lane === "promotion" &&
    soak?.realProcessSampling === true &&
    Boolean(chrome) &&
    chrome?.isolated === true &&
    chrome?.headless === true &&
    numberValue(chrome?.rootFoundSamples) !== null &&
    Number(chrome?.rootFoundSamples) > 0 &&
    numberValue(chrome?.nonzeroProcessSamples) !== null &&
    Number(chrome?.nonzeroProcessSamples) > 0 &&
    chrome?.cleanupConfirmed === true &&
    cleanup?.rootFound === false &&
    cleanup?.processCount === 0 &&
    cleanCycles(orphans) &&
    samples.length > 0 &&
    samples.every(
      (sample) =>
        isRecord(sample) &&
        sample.rootFound === true &&
        Number(sample.processCount) > 0 &&
        Number(sample.rssBytes) > 0,
    ) &&
    duration !== null &&
    duration >= options.requiredSoakDurationMs;
  if (!valid) reasons.push(`${prefix}_chrome_soak_unqualified`);
  return valid;
}
function qualifiedSoakRun(
  value: unknown,
  options: Required<ReleasePromotionGateOptions>,
  reasons: string[],
  index: number,
): boolean {
  const prefix = `soak_run_${index + 1}`;
  if (!isRecord(value)) {
    reasons.push(`${prefix}_invalid`);
    return false;
  }
  const provenance = provenanceValue(value);
  const runId = stringValue(value.runId);
  const runNumber = numberValue(value.runNumber);
  const sequence = numberValue(value.sequence);
  const generated = generatedAt(value);
  const duration = numberValue(value.observedDurationMs ?? value.durationMs ?? value.elapsedMs);
  const qualified = value.qualified === true || value.passed === true;
  let valid = true;
  if (!runId || runNumber === null || sequence === null || generated === null || !provenance) {
    reasons.push(`${prefix}_provenance_missing`);
    valid = false;
  }
  if (
    provenance &&
    options.expectedCommitSha &&
    stringValue(provenance.commitSha) !== options.expectedCommitSha
  ) {
    reasons.push(`${prefix}_commit_mismatch`);
    valid = false;
  }
  if (provenance && stringValue(provenance.runId) !== runId) {
    reasons.push(`${prefix}_run_mismatch`);
    valid = false;
  }
  if (!isClaimed(value)) {
    reasons.push(`${prefix}_unclaimed`);
    valid = false;
  }
  if (!qualified) {
    reasons.push(`${prefix}_not_qualified`);
    valid = false;
  }
  if (duration === null || duration < options.requiredSoakDurationMs) {
    reasons.push(`${prefix}_duration_short`);
    valid = false;
  }
  return valid;
}
type PlatformRun = {
  runId: string | null;
  runNumber: number | null;
  commitSha: string | null;
  generatedAt: string | number | null;
  sequence: number | null;
  platforms: Map<string, unknown>;
  attestations: JsonRecord;
};
function platformRuns(input: JsonRecord, manifests: JsonRecord): PlatformRun[] {
  const candidates: unknown[] = [];
  const declared = manifests.platformRuns ?? input.platformRuns;
  if (Array.isArray(declared)) candidates.push(...declared);
  const soak = nestedManifest(manifests, "soak", "resourceSoak", "soakManifest");
  if (candidates.length === 0 && isRecord(soak) && Array.isArray(soak.runs))
    for (const run of soak.runs)
      if (isRecord(run) && (run.platforms || run.manifests)) candidates.push(run);
  return candidates.map((candidate): PlatformRun => {
    const record = isRecord(candidate) ? candidate : {};
    const provenance = provenanceValue(record);
    const nested = isRecord(record.manifests) ? record.manifests : null;
    const source = record.platforms ?? nested?.platforms;
    const platforms = new Map<string, unknown>();
    if (isRecord(source))
      for (const [name, value] of Object.entries(source)) platforms.set(name.toLowerCase(), value);
    return {
      runId: stringValue(record.runId) ?? stringValue(provenance?.runId),
      runNumber: numberValue(record.runNumber) ?? numberValue(provenance?.runNumber),
      commitSha: stringValue(record.commitSha) ?? stringValue(provenance?.commitSha),
      generatedAt:
        (record.generatedAt as string | number | null) ??
        (provenance?.generatedAt as string | number | null) ??
        null,
      sequence: numberValue(record.sequence),
      platforms,
      attestations: isRecord(record.attestations) ? record.attestations : {},
    };
  });
}
export function evaluateReleasePromotionGate(
  value: unknown,
  suppliedOptions: ReleasePromotionGateOptions = {},
): ReleasePromotionGateResult {
  const options: Required<ReleasePromotionGateOptions> = {
    nowMs: suppliedOptions.nowMs ?? Date.now(),
    maxAgeMs: suppliedOptions.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    requiredSoakRuns: suppliedOptions.requiredSoakRuns ?? DEFAULT_REQUIRED_SOAK_RUNS,
    requiredSoakDurationMs:
      suppliedOptions.requiredSoakDurationMs ?? DEFAULT_REQUIRED_SOAK_DURATION_MS,
    expectedRepository: suppliedOptions.expectedRepository ?? "",
    expectedWorkflow: suppliedOptions.expectedWorkflow ?? "",
    expectedRunId: suppliedOptions.expectedRunId ?? "",
    expectedSupplementalRunId: suppliedOptions.expectedSupplementalRunId ?? "",
    expectedCommitSha: suppliedOptions.expectedCommitSha ?? "",
    expectedSourceRef: suppliedOptions.expectedSourceRef ?? "",
    trustedPublicKeys: suppliedOptions.trustedPublicKeys ?? suppliedOptions.trustedPublicKey ?? "",
    trustedPublicKey: suppliedOptions.trustedPublicKey ?? "",
  };
  const input = isRecord(value) ? value : {};
  const reasons: string[] = [];
  if (input.schemaVersion !== undefined && input.schemaVersion !== RELEASE_EVIDENCE_SCHEMA_VERSION)
    reasons.push("manifest_schema_invalid");
  const manifests = isRecord(input.manifests) ? input.manifests : input;
  const externalAttestations = isRecord(input.attestations) ? input.attestations : null;
  const capability = nestedManifest(
    manifests,
    "capability",
    "capabilityDrift",
    "capabilityManifest",
  );
  let capabilityDriftPassed = false;
  if (!isRecord(capability)) reasons.push("missing_capability_manifest");
  else {
    hasValidEnvelope(
      capability,
      "capability",
      reasons,
      options,
      "all",
      externalAttestations?.all,
      true,
      false,
    );
    capabilityDriftPassed =
      capability.passed === true &&
      isClaimed(capability) &&
      Array.isArray(capability.reasonCodes) &&
      capability.reasonCodes.length === 0;
    if (!isClaimed(capability)) reasons.push("capability_unclaimed");
    if (!capabilityDriftPassed) reasons.push("capability_drift_failed");
  }
  const review = nestedManifest(manifests, "review", "authenticatedReview", "reviewEvidence");
  if (!isRecord(review)) reasons.push("missing_authenticated_review_evidence");
  else {
    hasValidEnvelope(
      review,
      "review",
      reasons,
      options,
      "all",
      externalAttestations?.review,
      true,
      false,
    );
    if (!isClaimed(review) || review.passed !== true) reasons.push("review_unclaimed");
  }
  const observedEntries = platformEntries(input);
  const observedPlatforms = [...observedEntries.keys()].sort();
  for (const platform of observedPlatforms)
    if (!(REQUIRED_PLATFORMS as readonly string[]).includes(platform))
      reasons.push(`unexpected_platform_${platform}`);
  const runs = platformRuns(input, manifests);
  const runMetadata = new Map<string, PlatformRun>();
  const qualifiedRunIds = new Set<string>();
  for (const [index, run] of runs.entries()) {
    const runLabel = run.runId ?? `index-${index + 1}`;
    if (
      !run.runId ||
      run.runNumber === null ||
      !Number.isInteger(run.runNumber) ||
      run.runNumber <= 0 ||
      run.sequence === null ||
      generatedAt({ generatedAt: run.generatedAt }) === null
    ) {
      reasons.push(`platform_run_${runLabel}_provenance_invalid`);
      continue;
    }
    if (runMetadata.has(run.runId)) {
      reasons.push(`platform_run_${runLabel}_duplicate`);
      continue;
    }
    runMetadata.set(run.runId, run);
    if (options.expectedCommitSha && run.commitSha !== options.expectedCommitSha)
      reasons.push(`platform_run_${runLabel}_commit_mismatch`);
    let runQualified = true;
    for (const platform of run.platforms.keys())
      if (!(REQUIRED_PLATFORMS as readonly string[]).includes(platform))
        reasons.push(`platform_run_${runLabel}_unexpected_${platform}`);
    for (const platform of REQUIRED_PLATFORMS) {
      const entry = run.platforms.get(platform);
      if (!entry) {
        reasons.push(`platform_run_${runLabel}_missing_${platform}`);
        runQualified = false;
        continue;
      }
      const runOptions = { ...options, expectedRunId: run.runId };
      const valid = hasValidEnvelope(
        entry,
        `platform_${runLabel}_${platform}`,
        reasons,
        runOptions,
        platform,
        run.attestations[platform] ?? externalAttestations?.[`${run.runId}:${platform}`],
      );
      if (
        !isRecord(entry) ||
        !isClaimed(entry) ||
        !valid ||
        !qualifiesPlatform(entry, options, reasons, `platform_${runLabel}_${platform}`)
      )
        runQualified = false;
      const provenance = provenanceValue(entry);
      if (
        !provenance ||
        stringValue(provenance.runId) !== run.runId ||
        stringValue(provenance.commitSha) !== run.commitSha
      ) {
        reasons.push(`platform_${runLabel}_${platform}_run_provenance_mismatch`);
        runQualified = false;
      }
    }
    if (runQualified) qualifiedRunIds.add(run.runId);
  }
  if (runs.length === 0) {
    reasons.push("missing_platform_runs");
    for (const platform of REQUIRED_PLATFORMS)
      reasons.push(`missing_${platform}_platform_manifest`);
  }
  const soak = nestedManifest(manifests, "soak", "resourceSoak", "soakManifest");
  let qualifiedSoakRuns = 0;
  if (!isRecord(soak)) reasons.push("missing_soak_manifest");
  else {
    hasValidEnvelope(soak, "soak", reasons, options, "all", externalAttestations?.all, false, true);
    if (!isClaimed(soak)) reasons.push("soak_unclaimed");
    const soakRuns = Array.isArray(soak.runs) ? soak.runs : [];
    const qualifying = soakRuns.map((run, index) => qualifiedSoakRun(run, options, reasons, index));
    const sorted = soakRuns
      .map((run, index) => ({ run, index }))
      .filter(
        ({ run, index }) =>
          qualifying[index] && isRecord(run) && qualifiedRunIds.has(stringValue(run.runId) ?? ""),
      )
      .sort(
        (left, right) =>
          Number((left.run as JsonRecord).runNumber) - Number((right.run as JsonRecord).runNumber),
      );
    let streak = 0;
    let previousNumber: number | null = null;
    let previousId: string | null = null;
    for (const { run } of sorted) {
      const record = run as JsonRecord;
      const currentNumber = numberValue(record.runNumber);
      const currentId = stringValue(record.runId);
      if (currentNumber === null || currentId === null) continue;
      if (
        previousNumber !== null &&
        (currentNumber !== previousNumber + 1 || currentId === previousId)
      ) {
        if (currentNumber === previousNumber) reasons.push("soak_runs_duplicate_run_number");
        else reasons.push("soak_runs_not_consecutive");
        streak = 1;
      } else streak += 1;
      previousNumber = currentNumber;
      previousId = currentId;
      qualifiedSoakRuns = Math.max(qualifiedSoakRuns, streak);
    }
    if (qualifiedSoakRuns < options.requiredSoakRuns)
      reasons.push("soak_insufficient_consecutive_runs");
  }
  const rollback = nestedManifest(manifests, "rollback", "packagedRollback", "rollbackManifest");
  let rollbackProof = false;
  if (!isRecord(rollback)) reasons.push("missing_rollback_manifest");
  else {
    hasValidEnvelope(
      rollback,
      "rollback",
      reasons,
      options,
      "all",
      externalAttestations?.all,
      true,
      false,
    );
    rollbackProof =
      isClaimed(rollback) &&
      rollback.passed === true &&
      rollback.installCurrent === true &&
      rollback.injectedFailureObserved === true &&
      rollback.restoredPrevious === true &&
      rollback.helpPassed === true &&
      rollback.versionPassed === true &&
      rollback.doctorPassed === true &&
      rollback.noStaleProcess === true &&
      rollback.noProfileLock === true;
    if (!isClaimed(rollback)) reasons.push("rollback_unclaimed");
    if (!rollbackProof) reasons.push("rollback_not_proven");
  }
  const uniqueReasons = [...new Set(reasons)].sort();
  return {
    schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
    kind: "release-promotion-gate",
    passed: uniqueReasons.length === 0,
    reasonCodes: uniqueReasons,
    evidence: {
      requiredPlatforms: REQUIRED_PLATFORMS,
      observedPlatforms,
      requiredSoakRuns: options.requiredSoakRuns,
      qualifiedSoakRuns,
      requiredSoakDurationMs: options.requiredSoakDurationMs,
      rollbackProof,
      capabilityDriftPassed,
    },
  };
}
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
    if (
      name === `platform-${platform}.json` ||
      name === `${platform}.json` ||
      name === `resource-${platform}.json`
    )
      return platform;
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
    (group.platforms as JsonRecord)[platform] = value;
    const attestationPath = path.join(path.dirname(file), `attestation-platform-${platform}.json`);
    if (byName.has(attestationPath))
      (group.attestations as JsonRecord)[platform] = await readJson(attestationPath);
    groups.set(runId, group);
    (manifests.platforms as JsonRecord)[platform] = value;
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
      attestations: group.attestations,
    });
  }
  if (platformRuns.length > 0) manifests.platformRuns = platformRuns;
  return { schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION, manifests, attestations };
}
function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  return value && !value.startsWith("-") ? value : undefined;
}
function parseMilliseconds(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error("duration/age must be a positive number");
  return parsed;
}
async function main(args = process.argv.slice(2)): Promise<number> {
  const directory = option(args, "--evidence-dir") ?? option(args, "--evidence");
  if (!directory) {
    process.stderr.write("release promotion gate requires --evidence-dir path\n");
    return 2;
  }
  const outputPath = option(args, "--output");
  const requiredRuns = positiveInteger(
    option(args, "--required-soak-runs"),
    DEFAULT_REQUIRED_SOAK_RUNS,
  );
  const requiredDurationMs = parseMilliseconds(
    option(args, "--required-soak-duration-ms"),
    DEFAULT_REQUIRED_SOAK_DURATION_MS,
  );
  const maxAgeMs = parseMilliseconds(option(args, "--max-age-ms"), DEFAULT_MAX_AGE_MS);
  const expectedCommitSha = option(args, "--commit") ?? "";
  if (!expectedCommitSha) {
    process.stderr.write(
      "release promotion gate requires --commit; commit provenance is never optional\n",
    );
    return 2;
  }
  const trustedKeyOption = option(args, "--trusted-key") ?? process.env.RELEASE_TRUSTED_PUBLIC_KEY;
  let trustedPublicKey = trustedKeyOption;
  if (trustedKeyOption && !trustedKeyOption.includes("BEGIN PUBLIC KEY")) {
    try {
      trustedPublicKey = await readFile(path.resolve(trustedKeyOption), "utf8");
    } catch {
      trustedPublicKey = trustedKeyOption;
    }
  }
  const gateOptions: ReleasePromotionGateOptions = {
    requiredSoakRuns: requiredRuns,
    requiredSoakDurationMs: requiredDurationMs,
    maxAgeMs,
    expectedRepository:
      option(args, "--repository") ?? option(args, "--repo") ?? process.env.GITHUB_REPOSITORY ?? "",
    expectedWorkflow: option(args, "--workflow") ?? process.env.GITHUB_WORKFLOW ?? "",
    expectedRunId: option(args, "--run-id") ?? process.env.GITHUB_RUN_ID ?? "",
    expectedSupplementalRunId:
      option(args, "--supplemental-run-id") ??
      process.env.RELEASE_EVIDENCE_SUPPLEMENTAL_RUN_ID ??
      "",
    expectedCommitSha,
    expectedSourceRef: option(args, "--source-ref") ?? process.env.GITHUB_REF ?? "",
    trustedPublicKey,
  };
  let result: ReleasePromotionGateResult;
  try {
    result = evaluateReleasePromotionGate(
      await loadReleaseEvidenceDirectory(directory),
      gateOptions,
    );
  } catch {
    result = evaluateReleasePromotionGate({ invalid: true }, gateOptions);
  }
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) await writeFile(path.resolve(outputPath), output, "utf8");
  else process.stdout.write(output);
  return result.passed ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
