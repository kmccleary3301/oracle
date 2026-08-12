import { createPublicKey, verify as verifySignature } from "node:crypto";
import path from "node:path";
import {
  RELEASE_EVIDENCE_SCHEMA_VERSION,
  claim,
  generatedAt,
  hashReleaseEvidence,
  isRecord,
  numberValue,
  provenanceValue,
  readHash,
  releaseEvidenceSigningPayload,
  sourceValue,
  stringValue,
  type JsonRecord,
  type ReleasePromotionGateOptions,
} from "./release-evidence-core.js";

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

function normalizedWorkflowIdentity(value: unknown): string | null {
  const workflow = stringValue(value);
  if (!workflow) return null;
  return workflow.replace(/^https:\/\/github\.com\//, "").split("@", 1)[0] || null;
}

function normalizedRepositoryIdentity(value: unknown): string | null {
  const repository = stringValue(value);
  if (!repository) return null;
  return repository.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "") || null;
}
function runIdFromInvocation(value: unknown): string | null {
  const invocation = stringValue(value);
  return invocation?.match(/\/actions\/runs\/(\d+)(?:\/|$)/)?.[1] ?? null;
}
function attestationFacts(attestation: JsonRecord): JsonRecord | null {
  const verification = attestation.verification ?? attestation.rawVerification ?? attestation.raw;
  if (!verification || (isRecord(verification) && Object.keys(verification).length === 0))
    return null;
  const result = parsedVerificationResult(verification);
  if (result) {
    const signature = isRecord(result.signature) ? result.signature : null;
    const certificate = signature && isRecord(signature.certificate) ? signature.certificate : null;
    const claims =
      certificate && isRecord(certificate.extensions) ? certificate.extensions : certificate;
    const statement = isRecord(result.statement) ? result.statement : null;
    const subjects = statement && Array.isArray(statement.subject) ? statement.subject : [];
    const subject = subjects.find(isRecord) ?? null;
    const digest = subject && isRecord(subject.digest) ? subject.digest : null;
    return {
      repository:
        normalizedRepositoryIdentity(
          claims?.sourceRepositoryURI ?? claims?.githubWorkflowRepository,
        ) ??
        (/^\d+$/.test(String(claims?.sourceRepositoryIdentifier ?? ""))
          ? null
          : normalizedRepositoryIdentity(claims?.sourceRepositoryIdentifier)),
      workflow: normalizedWorkflowIdentity(claims?.buildSignerURI ?? claims?.githubWorkflowRef),
      runId:
        stringValue(claims?.githubWorkflowRunID) ??
        (typeof claims?.githubWorkflowRunID === "number"
          ? String(claims.githubWorkflowRunID)
          : null) ??
        runIdFromInvocation(claims?.runInvocationURI),
      commitSha: stringValue(claims?.sourceRepositoryDigest),
      sourceRef: stringValue(claims?.sourceRepositoryRef),
      subjectPath: stringValue(subject?.name),
      artifactDigest: normalizedSha256(digest?.sha256),
      issuer:
        stringValue(claims?.oidcIssuer) ??
        stringValue(claims?.issuer) ??
        stringValue(claims?.certificateIssuer),
    };
  }
  return {
    repository: normalizedRepositoryIdentity(
      nestedClaim(verification, [
        "sourceRepositoryURI",
        "githubWorkflowRepository",
        "sourceRepository",
        "repository",
        "repo",
      ]),
    ),
    workflow: normalizedWorkflowIdentity(
      nestedClaim(verification, [
        "buildSignerURI",
        "githubWorkflowRef",
        "signerWorkflow",
        "workflow",
        "workflowName",
        "workflowRef",
      ]),
    ),
    runId:
      nestedClaim(verification, ["githubWorkflowRunID", "runId", "run_id", "workflowRunId"]) ??
      runIdFromInvocation(nestedClaim(verification, ["runInvocationURI"])),
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
    issuer: nestedClaim(verification, ["oidcIssuer", "issuer", "certificateIssuer", "issuerUrl"]),
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
  const actualRepository = stringValue(facts.repository);
  const actualWorkflow = normalizedWorkflowIdentity(facts.workflow);
  const actualRunId = stringValue(facts.runId);
  const actualCommit = stringValue(facts.commitSha);
  const actualSourceRef = stringValue(facts.sourceRef);
  if (pinned) {
    const pinnedClaims: Array<[string, string | null, string | null]> = [
      ["repository", claim(pinned, "repository"), actualRepository],
      [
        "workflow",
        normalizedWorkflowIdentity(claim(pinned, "signerWorkflow", "workflow")),
        actualWorkflow,
      ],
      ["run_id", claim(pinned, "runId"), actualRunId],
      ["commit", claim(pinned, "sourceCommit", "commitSha"), actualCommit],
      ["source_ref", claim(pinned, "sourceRef"), actualSourceRef],
    ];
    for (const [name, pinnedValue, actual] of pinnedClaims)
      if (!pinnedValue || !actual || pinnedValue !== actual)
        reasons.push(`${reasonPrefix}_attestation_pinned_${name}_mismatch`);
  }
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
  if (facts.issuer !== "https://token.actions.githubusercontent.com")
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
export function hasValidEnvelope(
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
