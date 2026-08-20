#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_REQUIRED_SOAK_DURATION_MS,
  DEFAULT_REQUIRED_SOAK_RUNS,
  RELEASE_EVIDENCE_SCHEMA_VERSION,
  REQUIRED_PLATFORMS,
  generatedAt,
  isClaimed,
  isRecord,
  numberValue,
  positiveInteger,
  provenanceValue,
  stringValue,
  type JsonRecord,
  type ReleasePromotionGateOptions,
  type ReleasePromotionGateResult,
} from "./release-evidence-core.js";
import { hasValidEnvelope } from "./release-evidence-envelope.js";
import { loadReleaseEvidenceDirectory } from "./release-evidence-loader.js";
import {
  liveProcessSoakQualifies,
  promotionSoakContinuityQualifies,
  soakDurationMs,
} from "./release-evidence-soak.js";

export {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_PROMOTION_RSS_SLOPE_BYTES_PER_SECOND,
  DEFAULT_REQUIRED_SOAK_DURATION_MS,
  DEFAULT_REQUIRED_SOAK_RUNS,
  PROMOTION_RSS_NOISE_METHOD,
  PROMOTION_RSS_SLOPE_METHOD,
  RELEASE_EVIDENCE_SCHEMA_VERSION,
  REQUIRED_PLATFORMS,
  hashReleaseEvidence,
  releaseEvidenceSigningPayload,
  type ReleasePromotionGateOptions,
  type ReleaseProofMode,
  type ReleasePromotionGateResult,
  type RequiredPlatform,
} from "./release-evidence-core.js";
export { loadReleaseEvidenceDirectory } from "./release-evidence-loader.js";

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
function qualifiesPlatform(value: JsonRecord, reasons: string[], prefix: string): boolean {
  const valid =
    value.qualified === true &&
    isClaimed(value) &&
    value.lane === "matrix" &&
    liveProcessSoakQualifies(value) &&
    (soakDurationMs(value) ?? 0) > 0;
  if (!valid) reasons.push(`${prefix}_matrix_unqualified`);
  return valid;
}

function qualifiesSoakEvidence(
  value: JsonRecord,
  options: Required<ReleasePromotionGateOptions>,
  reasons: string[],
  prefix: string,
): boolean {
  const duration = soakDurationMs(value);
  const valid =
    value.platform === "macos" &&
    value.qualified === true &&
    isClaimed(value) &&
    value.lane === "promotion" &&
    liveProcessSoakQualifies(value) &&
    promotionSoakContinuityQualifies(value, options.requiredSoakDurationMs) &&
    duration !== null &&
    duration >= options.requiredSoakDurationMs;
  if (!valid) reasons.push(`${prefix}_unqualified`);
  return valid;
}

type AuthenticatedPlatformRun = {
  runId: string;
  runNumber: number;
  commitSha: string;
  durationMs: number;
};
function qualifiedSoakRun(
  value: unknown,
  options: Required<ReleasePromotionGateOptions>,
  reasons: string[],
  index: number,
  authenticatedRun: AuthenticatedPlatformRun | undefined,
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
  const declaredDuration = numberValue(
    value.observedDurationMs ?? value.durationMs ?? value.elapsedMs,
  );
  const qualified = value.qualified === true || value.passed === true;
  let valid = true;
  if (!runId || runNumber === null || sequence === null || generated === null || !provenance) {
    reasons.push(`${prefix}_provenance_missing`);
    valid = false;
  }
  if (!authenticatedRun) {
    reasons.push(`${prefix}_platform_run_missing`);
    valid = false;
  } else {
    if (runNumber !== authenticatedRun.runNumber) {
      reasons.push(`${prefix}_run_number_mismatch`);
      valid = false;
    }
    if (sequence !== authenticatedRun.runNumber) {
      reasons.push(`${prefix}_sequence_mismatch`);
      valid = false;
    }
    if (declaredDuration !== null && declaredDuration !== authenticatedRun.durationMs) {
      reasons.push(`${prefix}_duration_mismatch`);
      valid = false;
    }
    if (authenticatedRun.durationMs < options.requiredSoakDurationMs) {
      reasons.push(`${prefix}_duration_short`);
      valid = false;
    }
  }
  if (provenance) {
    const expectedCommit = authenticatedRun?.commitSha ?? options.expectedCommitSha;
    if (expectedCommit && stringValue(provenance.commitSha) !== expectedCommit) {
      reasons.push(`${prefix}_commit_mismatch`);
      valid = false;
    }
    if (stringValue(provenance.runId) !== runId) {
      reasons.push(`${prefix}_run_mismatch`);
      valid = false;
    }
    if (authenticatedRun && numberValue(provenance.runNumber) !== authenticatedRun.runNumber) {
      reasons.push(`${prefix}_provenance_run_number_mismatch`);
      valid = false;
    }
    if (
      options.expectedRepository &&
      stringValue(provenance.repository) !== options.expectedRepository
    ) {
      reasons.push(`${prefix}_repository_mismatch`);
      valid = false;
    }
    if (options.expectedWorkflow && stringValue(provenance.workflow) !== options.expectedWorkflow) {
      reasons.push(`${prefix}_workflow_mismatch`);
      valid = false;
    }
    if (
      options.expectedSourceRef &&
      stringValue(provenance.sourceRef) !== options.expectedSourceRef
    ) {
      reasons.push(`${prefix}_source_ref_mismatch`);
      valid = false;
    }
  }
  if (!isClaimed(value)) {
    reasons.push(`${prefix}_unclaimed`);
    valid = false;
  }
  if (!qualified) {
    reasons.push(`${prefix}_not_qualified`);
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
  soak: unknown;
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
      soak: record.soak,
      attestations: isRecord(record.attestations) ? record.attestations : {},
    };
  });
}
export function evaluateReleasePromotionGate(
  value: unknown,
  suppliedOptions: ReleasePromotionGateOptions = {},
): ReleasePromotionGateResult {
  const requestedMode = suppliedOptions.mode;
  const proofModeInvalid =
    requestedMode !== undefined && requestedMode !== "bounded" && requestedMode !== "extended";
  const mode = requestedMode === "bounded" ? "bounded" : "extended";
  const extendedAssurance = mode === "extended";
  const options: Required<ReleasePromotionGateOptions> = {
    mode,
    nowMs: suppliedOptions.nowMs ?? Date.now(),
    maxAgeMs: suppliedOptions.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    requiredSoakRuns: extendedAssurance
      ? Math.max(
          DEFAULT_REQUIRED_SOAK_RUNS,
          suppliedOptions.requiredSoakRuns ?? DEFAULT_REQUIRED_SOAK_RUNS,
        )
      : 0,
    requiredSoakDurationMs: extendedAssurance
      ? Math.max(
          DEFAULT_REQUIRED_SOAK_DURATION_MS,
          suppliedOptions.requiredSoakDurationMs ?? DEFAULT_REQUIRED_SOAK_DURATION_MS,
        )
      : 0,
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
  if (proofModeInvalid) reasons.push("proof_mode_invalid");
  if (input.schemaVersion !== undefined && input.schemaVersion !== RELEASE_EVIDENCE_SCHEMA_VERSION)
    reasons.push("manifest_schema_invalid");
  const manifests = isRecord(input.manifests) ? input.manifests : input;
  const externalAttestations = isRecord(input.attestations) ? input.attestations : null;
  let capabilityDriftPassed = false;
  if (extendedAssurance) {
    const capability = nestedManifest(
      manifests,
      "capability",
      "capabilityDrift",
      "capabilityManifest",
    );
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
  }
  const observedEntries = platformEntries(input);
  const observedPlatforms = [...observedEntries.keys()].sort();
  for (const platform of observedPlatforms)
    if (!(REQUIRED_PLATFORMS as readonly string[]).includes(platform))
      reasons.push(`unexpected_platform_${platform}`);
  const runs = platformRuns(input, manifests);
  const runMetadata = new Map<string, PlatformRun>();
  const authenticatedRuns = new Map<string, AuthenticatedPlatformRun>();
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
    let authenticatedRunNumber: number | null = null;
    let authenticatedCommitSha: string | null = null;
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
        !qualifiesPlatform(entry, reasons, `platform_${runLabel}_${platform}`)
      )
        runQualified = false;
      const provenance = provenanceValue(entry);
      const provenanceRunNumber = numberValue(provenance?.runNumber);
      const provenanceCommitSha = stringValue(provenance?.commitSha);
      if (
        !provenance ||
        stringValue(provenance.runId) !== run.runId ||
        provenanceCommitSha !== run.commitSha
      ) {
        reasons.push(`platform_${runLabel}_${platform}_run_provenance_mismatch`);
        runQualified = false;
      }
      if (
        provenanceRunNumber === null ||
        !Number.isInteger(provenanceRunNumber) ||
        provenanceRunNumber <= 0
      ) {
        reasons.push(`platform_${runLabel}_${platform}_run_number_invalid`);
        runQualified = false;
      } else if (
        authenticatedRunNumber !== null &&
        provenanceRunNumber !== authenticatedRunNumber
      ) {
        reasons.push(`platform_${runLabel}_${platform}_run_number_mismatch`);
        runQualified = false;
      } else {
        authenticatedRunNumber = provenanceRunNumber;
      }
      if (!provenanceCommitSha) {
        runQualified = false;
      } else if (
        authenticatedCommitSha !== null &&
        provenanceCommitSha !== authenticatedCommitSha
      ) {
        reasons.push(`platform_${runLabel}_${platform}_commit_mismatch`);
        runQualified = false;
      } else {
        authenticatedCommitSha = provenanceCommitSha;
      }
    }
    if (
      authenticatedRunNumber !== null &&
      (run.runNumber !== authenticatedRunNumber || run.sequence !== authenticatedRunNumber)
    ) {
      reasons.push(`platform_run_${runLabel}_run_number_mismatch`);
      runQualified = false;
    }
    if (extendedAssurance) {
      const soakEntry = run.soak;
      let authenticatedDurationMs: number | null = null;
      if (!isRecord(soakEntry)) {
        reasons.push(`soak_${runLabel}_manifest_invalid`);
        runQualified = false;
      } else {
        const soakPlatform = stringValue(soakEntry.platform);
        const soakOptions = { ...options, expectedRunId: run.runId };
        const valid =
          Boolean(soakPlatform) &&
          hasValidEnvelope(
            soakEntry,
            `soak_${runLabel}`,
            reasons,
            soakOptions,
            soakPlatform ?? undefined,
            run.attestations.soak ?? externalAttestations?.[`${run.runId}:soak`],
          );
        const qualifies = qualifiesSoakEvidence(soakEntry, options, reasons, `soak_${runLabel}`);
        if (!valid || !isClaimed(soakEntry) || !qualifies) runQualified = false;
        const provenance = provenanceValue(soakEntry);
        authenticatedDurationMs = soakDurationMs(soakEntry);
        if (
          !provenance ||
          stringValue(provenance.runId) !== run.runId ||
          numberValue(provenance.runNumber) !== authenticatedRunNumber ||
          stringValue(provenance.commitSha) !== authenticatedCommitSha
        ) {
          reasons.push(`soak_${runLabel}_run_provenance_mismatch`);
          runQualified = false;
        }
      }
      if (
        runQualified &&
        authenticatedRunNumber !== null &&
        authenticatedCommitSha !== null &&
        authenticatedDurationMs !== null
      ) {
        authenticatedRuns.set(run.runId, {
          runId: run.runId,
          runNumber: authenticatedRunNumber,
          commitSha: authenticatedCommitSha,
          durationMs: authenticatedDurationMs,
        });
      }
    }
  }
  if (runs.length === 0) {
    reasons.push("missing_platform_runs");
    for (const platform of REQUIRED_PLATFORMS)
      reasons.push(`missing_${platform}_platform_manifest`);
  }
  let qualifiedSoakRuns = 0;
  if (extendedAssurance) {
    const soak = nestedManifest(manifests, "soak", "resourceSoak", "soakManifest");
    if (!isRecord(soak)) reasons.push("missing_soak_manifest");
    else {
      hasValidEnvelope(
        soak,
        "soak",
        reasons,
        options,
        "all",
        externalAttestations?.all,
        false,
        true,
      );
      if (!isClaimed(soak)) reasons.push("soak_unclaimed");
      const soakRuns = Array.isArray(soak.runs) ? soak.runs : [];
      const candidates = soakRuns.map((run, index) => {
        const runId = isRecord(run) ? stringValue(run.runId) : null;
        const authenticatedRun = runId ? authenticatedRuns.get(runId) : undefined;
        return {
          run,
          index,
          authenticatedRun,
          qualifies: qualifiedSoakRun(run, options, reasons, index, authenticatedRun),
        };
      });
      const sorted = candidates
        .filter(
          (
            candidate,
          ): candidate is typeof candidate & { authenticatedRun: AuthenticatedPlatformRun } =>
            candidate.qualifies && Boolean(candidate.authenticatedRun),
        )
        .sort((left, right) => left.authenticatedRun.runNumber - right.authenticatedRun.runNumber);
      let streak = 0;
      let previousNumber: number | null = null;
      let previousId: string | null = null;
      for (const { authenticatedRun } of sorted) {
        const currentNumber = authenticatedRun.runNumber;
        const currentId = authenticatedRun.runId;
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
  }
  let rollbackProof = false;
  if (extendedAssurance) {
    const rollback = nestedManifest(manifests, "rollback", "packagedRollback", "rollbackManifest");
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
  }
  const uniqueReasons = [...new Set(reasons)].sort();
  return {
    schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
    kind: "release-promotion-gate",
    passed: uniqueReasons.length === 0,
    reasonCodes: uniqueReasons,
    evidence: {
      mode,
      extendedAssuranceEvaluated: extendedAssurance,
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
  const mode = option(args, "--mode") ?? "extended";
  if (mode !== "bounded" && mode !== "extended") {
    process.stderr.write("release promotion gate --mode must be bounded or extended\n");
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
    mode,
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
