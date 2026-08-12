import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REQUIRED_SOAK_DURATION_MS,
  evaluateReleasePromotionGate,
  hashReleaseEvidence,
  releaseEvidenceSigningPayload,
  REQUIRED_PLATFORMS,
  type ReleasePromotionGateOptions,
  type RequiredPlatform,
} from "../../scripts/release-promotion-gate.js";

const NOW = Date.parse("2026-08-10T12:00:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const TRUSTED_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();
const EXPECTED = {
  expectedRepository: "acme/oracle",
  expectedWorkflow: "acme/oracle/.github/workflows/nightly-release-evidence.yml",
  expectedRunId: "102",
  expectedSourceRef: "refs/heads/main",
  expectedCommitSha: "abc123",
  trustedPublicKey: TRUSTED_PUBLIC_KEY,
};

function signed<T extends Record<string, unknown>>(
  value: T,
  platform = "all",
  runId = "102",
  runNumber = Number(runId),
): T & { sha256: string } {
  const provenance = {
    repository: "acme/oracle",
    workflow: EXPECTED.expectedWorkflow,
    runId,
    runNumber,
    sourceRef: "refs/heads/main",
    commitSha: "abc123",
    sourceArtifactDigest: `sha256:${"a".repeat(64)}`,
    platform,
    subjectPath: platform === "all" ? "release-evidence/all.json" : `platform-${platform}.json`,
  };
  const unsigned = { ...value, provenance };
  const signature = sign(
    null,
    Buffer.from(releaseEvidenceSigningPayload(unsigned), "utf8"),
    privateKey,
  ).toString("base64url");
  const withSignature = {
    ...unsigned,
    provenance: { ...provenance, signature: { algorithm: "ed25519", keyId: "default", signature } },
  };
  return { ...withSignature, sha256: hashReleaseEvidence(withSignature) } as T & { sha256: string };
}

function platform(platform: RequiredPlatform, runNumber: number): Record<string, unknown> {
  const runId = String(runNumber);
  return signed(
    {
      schemaVersion: 1,
      kind: "release-platform-evidence",
      platform,
      status: "claimed",
      qualified: true,
      lane: "promotion",
      generatedAt: new Date(NOW).toISOString(),
      source: {
        workflow: EXPECTED.expectedWorkflow,
        artifactPath: `platform-${platform}.json`,
        commitSha: "abc123",
      },
      resourceBaseline: { schemaVersion: 1, cleanup: { rootFound: false }, passed: true },
      observedDurationMs: DEFAULT_REQUIRED_SOAK_DURATION_MS,
      soak: {
        realProcessSampling: true,
        samples: [{ rootFound: true, processCount: 3, rssBytes: 100 }],
        chrome: {
          isolated: true,
          headless: true,
          rootFoundSamples: 1,
          nonzeroProcessSamples: 1,
          cleanupConfirmed: true,
        },
        cleanup: { rootFound: false, processCount: 0 },
        orphans: {
          samplesWithActiveTargets: 0,
          maxActiveTargetsAfterRelease: 0,
          cycles: [{ baselineRestored: true }],
        },
        promotionGate: { observedDurationMs: DEFAULT_REQUIRED_SOAK_DURATION_MS },
      },
    },
    platform,
    runId,
    runNumber,
  );
}

function soakRun(runNumber: number): Record<string, unknown> {
  const runId = String(runNumber);
  return {
    sequence: runNumber,
    runNumber,
    runId,
    status: "claimed",
    qualified: true,
    generatedAt: new Date(NOW).toISOString(),
    observedDurationMs: DEFAULT_REQUIRED_SOAK_DURATION_MS,
    provenance: {
      repository: EXPECTED.expectedRepository,
      workflow: EXPECTED.expectedWorkflow,
      runId,
      runNumber,
      sourceRef: EXPECTED.expectedSourceRef,
      commitSha: EXPECTED.expectedCommitSha,
      sourceArtifactDigest: `sha256:${"b".repeat(64)}`,
      platform: "all",
    },
  };
}

function evidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const platformRuns = [100, 101, 102].map((runNumber) => ({
    runId: String(runNumber),
    runNumber,
    sequence: runNumber,
    commitSha: "abc123",
    generatedAt: new Date(NOW).toISOString(),
    platforms: Object.fromEntries(
      REQUIRED_PLATFORMS.map((name) => [name, platform(name, runNumber)]),
    ),
  }));
  const source = {
    workflow: EXPECTED.expectedWorkflow,
    artifactPath: "release-evidence/evidence.json",
    commitSha: EXPECTED.expectedCommitSha,
  };
  const base = {
    schemaVersion: 1,
    manifests: {
      capability: signed({
        schemaVersion: 1,
        kind: "chatgpt-capability-promotion-gate",
        status: "claimed",
        passed: true,
        reasonCodes: [],
        generatedAt: new Date(NOW).toISOString(),
        source,
      }),
      review: signed({
        schemaVersion: 1,
        kind: "authenticated-review-evidence",
        status: "claimed",
        passed: true,
        generatedAt: new Date(NOW).toISOString(),
        source,
      }),
      platforms: Object.fromEntries(REQUIRED_PLATFORMS.map((name) => [name, platform(name, 102)])),
      platformRuns,
      soak: signed({
        schemaVersion: 1,
        kind: "resource-soak-promotion-evidence",
        status: "claimed",
        qualified: true,
        generatedAt: new Date(NOW).toISOString(),
        source,
        runs: [100, 101, 102].map(soakRun),
      }),
      rollback: signed({
        schemaVersion: 1,
        kind: "packaged-rollback-proof",
        status: "claimed",
        passed: true,
        installCurrent: true,
        injectedFailureObserved: true,
        restoredPrevious: true,
        helpPassed: true,
        versionPassed: true,
        doctorPassed: true,
        noStaleProcess: true,
        noProfileLock: true,
        generatedAt: new Date(NOW).toISOString(),
        source,
      }),
    },
  };
  return { ...base, ...overrides };
}
function gateOptions(
  overrides: Partial<ReleasePromotionGateOptions> = {},
): ReleasePromotionGateOptions {
  return { nowMs: NOW, ...EXPECTED, ...overrides };
}

describe("release promotion evidence gate", () => {
  it("passes only with exact platforms, three distinct consecutive full-duration runs, and signed evidence", () => {
    const result = evaluateReleasePromotionGate(evidence(), gateOptions());
    expect(result).toMatchObject({ passed: true, reasonCodes: [] });
    expect(result.evidence.observedPlatforms).toEqual(["linux", "macos", "windows"]);
    expect(result.evidence.qualifiedSoakRuns).toBe(3);
  });

  it("does not let a single matrix run count as three runs", () => {
    const input = evidence();
    const manifests = input.manifests as Record<string, unknown>;
    const platformRuns = manifests.platformRuns as Array<Record<string, unknown>>;
    manifests.platformRuns = [platformRuns[2]];
    const soak = manifests.soak as Record<string, unknown>;
    const soakRuns = soak.runs as Array<Record<string, unknown>>;
    soak.runs = [soakRuns[2]];
    soak.sha256 = hashReleaseEvidence(soak);
    const result = evaluateReleasePromotionGate(input, gateOptions());
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain("soak_insufficient_consecutive_runs");
  });

  it("rejects cross-run commit mismatch", () => {
    const input = evidence();
    const runs = (input.manifests as Record<string, unknown>).platformRuns as Array<
      Record<string, unknown>
    >;
    runs[1].commitSha = "different";
    const result = evaluateReleasePromotionGate(input, gateOptions());
    expect(result.reasonCodes).toContain("platform_run_101_commit_mismatch");
    expect(result.passed).toBe(false);
  });

  it("rejects non-consecutive workflow run numbers", () => {
    const input = evidence();
    const manifests = input.manifests as Record<string, unknown>;
    const runs = manifests.platformRuns as Array<Record<string, unknown>>;
    runs[1].runNumber = 104;
    runs[1].sequence = 104;
    const soak = manifests.soak as Record<string, unknown>;
    const soakRuns = soak.runs as Array<Record<string, unknown>>;
    soakRuns[1].runNumber = 104;
    soakRuns[1].sequence = 104;
    soak.sha256 = hashReleaseEvidence(soak);
    const result = evaluateReleasePromotionGate(input, gateOptions());
    expect(result.reasonCodes).toContain("soak_runs_not_consecutive");
    expect(result.passed).toBe(false);
  });
  it("does not count a soak run without generatedAt provenance", () => {
    const input = evidence();
    const soak = (input.manifests as Record<string, unknown>).soak as Record<string, unknown>;
    const runs = soak.runs as Array<Record<string, unknown>>;
    delete runs[1].generatedAt;
    soak.sha256 = hashReleaseEvidence(soak);
    const result = evaluateReleasePromotionGate(input, gateOptions());
    expect(result.reasonCodes).toContain("soak_run_2_provenance_missing");
    expect(result.passed).toBe(false);
  });
  it("accepts mixed platform attestations with signed supplement manifests", () => {
    const input = evidence();
    const runs = (input.manifests as Record<string, unknown>).platformRuns as Array<
      Record<string, unknown>
    >;
    const linux = (runs[0].platforms as Record<string, unknown>).linux as Record<string, unknown>;
    delete (linux.provenance as Record<string, unknown>).signature;
    linux.sha256 = hashReleaseEvidence(linux);
    input.attestations = {
      "100:linux": {
        verified: true,
        subjectPath: "platform-linux.json",
        subjectDigest: `sha256:${"a".repeat(64)}`,
        pinned: {
          repository: EXPECTED.expectedRepository,
          signerWorkflow: EXPECTED.expectedWorkflow,
          runId: "100",
          sourceCommit: EXPECTED.expectedCommitSha,
          sourceRef: EXPECTED.expectedSourceRef,
        },
        verification: [
          {
            verificationResult: {
              signature: {
                certificate: {
                  extensions: {
                    sourceRepositoryIdentifier: EXPECTED.expectedRepository,
                    sourceRepositoryDigest: EXPECTED.expectedCommitSha,
                    sourceRepositoryRef: EXPECTED.expectedSourceRef,
                    githubWorkflowRunID: "100",
                  },
                },
              },
              statement: {
                subject: [
                  {
                    name: ".release-evidence/platform-linux.json",
                    digest: { sha256: "a".repeat(64) },
                  },
                ],
              },
            },
          },
        ],
      },
    };
    expect(evaluateReleasePromotionGate(input, gateOptions())).toMatchObject({
      passed: true,
      reasonCodes: [],
    });
  });

  it("rejects an unsigned supplemental capability manifest", () => {
    const input = evidence();
    const capability = (input.manifests as Record<string, unknown>).capability as Record<
      string,
      unknown
    >;
    delete (capability.provenance as Record<string, unknown>).signature;
    capability.sha256 = hashReleaseEvidence(capability);
    const result = evaluateReleasePromotionGate(input, gateOptions());
    expect(result.reasonCodes).toContain("capability_attestation_invalid");
    expect(result.passed).toBe(false);
  });

  it("allows only the explicitly selected supplemental evidence run", () => {
    const input = evidence();
    const manifests = input.manifests as Record<string, unknown>;
    const capability = manifests.capability as Record<string, unknown>;
    delete capability.provenance;
    delete capability.sha256;
    manifests.capability = signed(capability, "all", "777", 777);

    const rejected = evaluateReleasePromotionGate(input, gateOptions());
    expect(rejected.reasonCodes).toContain("capability_run_mismatch");
    expect(rejected.passed).toBe(false);

    const accepted = evaluateReleasePromotionGate(
      input,
      gateOptions({ expectedSupplementalRunId: "777" }),
    );
    expect(accepted).toMatchObject({ passed: true, reasonCodes: [] });
  });

  it("rejects unsigned and tampered platform manifests", () => {
    const unsignedInput = evidence();
    const unsignedRuns = unsignedInput.manifests as Record<string, unknown>;
    const unsignedPlatform = (
      (unsignedRuns.platformRuns as Array<Record<string, unknown>>)[0].platforms as Record<
        string,
        unknown
      >
    ).linux as Record<string, unknown>;
    delete (unsignedPlatform.provenance as Record<string, unknown>).signature;
    unsignedPlatform.sha256 = hashReleaseEvidence(unsignedPlatform);
    expect(evaluateReleasePromotionGate(unsignedInput, gateOptions()).reasonCodes).toContain(
      "platform_100_linux_attestation_invalid",
    );

    const tamperedInput = evidence();
    const tamperedRuns = tamperedInput.manifests as Record<string, unknown>;
    const tamperedPlatform = (
      (tamperedRuns.platformRuns as Array<Record<string, unknown>>)[0].platforms as Record<
        string,
        unknown
      >
    ).linux as Record<string, unknown>;
    tamperedPlatform.status = "tampered";
    expect(evaluateReleasePromotionGate(tamperedInput, gateOptions()).reasonCodes).toContain(
      "platform_100_linux_signature_invalid",
    );
  });

  it("rejects incomplete rollback and absent authenticated review", () => {
    const input = evidence();
    const manifests = input.manifests as Record<string, unknown>;
    delete manifests.review;
    const rollback = manifests.rollback as Record<string, unknown>;
    rollback.noProfileLock = false;
    rollback.sha256 = hashReleaseEvidence(rollback);
    const result = evaluateReleasePromotionGate(input, gateOptions());
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(["missing_authenticated_review_evidence", "rollback_not_proven"]),
    );
    expect(result.passed).toBe(false);
  });

  it("fails closed for missing evidence", () => {
    const result = evaluateReleasePromotionGate({}, gateOptions());
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        "missing_platform_runs",
        "missing_capability_manifest",
        "missing_rollback_manifest",
        "missing_soak_manifest",
      ]),
    );
  });
});
