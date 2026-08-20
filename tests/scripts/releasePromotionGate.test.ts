import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REQUIRED_SOAK_DURATION_MS,
  evaluateReleasePromotionGate,
  hashReleaseEvidence,
  releaseEvidenceSigningPayload,
  loadReleaseEvidenceDirectory,
  DEFAULT_MAX_PROMOTION_RSS_SLOPE_BYTES_PER_SECOND,
  PROMOTION_RSS_NOISE_METHOD,
  PROMOTION_RSS_SLOPE_METHOD,
  REQUIRED_PLATFORMS,
  type ReleasePromotionGateOptions,
  type RequiredPlatform,
} from "../../scripts/release-promotion-gate.js";
import {
  countConsecutiveQualifiedRuns,
  platformEvidenceQualifies,
  platformSoakQualifies,
} from "../../scripts/release-evidence-manifest.js";

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

function liveSoak(durationMs: number): Record<string, unknown> {
  const rootPid = 42;
  const sampleStepMs = 15_000;
  const samples = Array.from({ length: Math.ceil(durationMs / sampleStepMs) + 1 }, (_, index) => ({
    sampledAtMs: Math.min(index * sampleStepMs, durationMs),
    rootPid,
    rootFound: true,
    processCount: 3,
    rssBytes: 100,
  }));
  return {
    realProcessSampling: true,
    rootPid,
    durationMs,
    requestedDurationMs: durationMs,
    sampleIntervalMs: sampleStepMs,
    sampleCount: samples.length,
    samples,
    chrome: {
      isolated: true,
      headless: true,
      rootFoundSamples: samples.length,
      nonzeroProcessSamples: samples.length,
      cleanupConfirmed: true,
    },
    cleanup: { rootPid, rootFound: false, processCount: 0 },
    rss: {
      slopeBytesPerSecond: 1,
      minBytes: 100,
      maxBytes: 101,
      noiseBytes: 1,
    },
    promotionGate: {
      observedDurationMs: durationMs,
      rssSlope: {
        method: PROMOTION_RSS_SLOPE_METHOD,
        noiseMethod: PROMOTION_RSS_NOISE_METHOD,
        observedBytesPerSecond: 1,
        maxBytesPerSecond: DEFAULT_MAX_PROMOTION_RSS_SLOPE_BYTES_PER_SECOND,
        noiseBytes: 1,
      },
    },
    orphans: {
      samplesWithActiveTargets: 0,
      maxActiveTargetsAfterRelease: 0,
      cycles: samples.map(() => ({ baselineRestored: true })),
    },
  };
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
      lane: "matrix",
      generatedAt: new Date(NOW).toISOString(),
      source: {
        workflow: EXPECTED.expectedWorkflow,
        artifactPath: `platform-${platform}.json`,
        commitSha: "abc123",
      },
      resourceBaseline: { schemaVersion: 1, cleanup: { rootFound: false }, passed: true },
      observedDurationMs: 5_000,
      soak: liveSoak(5_000),
    },
    platform,
    runId,
    runNumber,
  );
}

function soakEvidence(runNumber: number): Record<string, unknown> {
  const runId = String(runNumber);
  return signed(
    {
      schemaVersion: 1,
      kind: "release-soak-evidence",
      platform: "macos",
      status: "claimed",
      qualified: true,
      lane: "promotion",
      generatedAt: new Date(NOW).toISOString(),
      source: {
        workflow: EXPECTED.expectedWorkflow,
        artifactPath: "soak-evidence.json",
        commitSha: "abc123",
      },
      observedDurationMs: DEFAULT_REQUIRED_SOAK_DURATION_MS,
      requiredDurationMs: DEFAULT_REQUIRED_SOAK_DURATION_MS,
      soak: liveSoak(DEFAULT_REQUIRED_SOAK_DURATION_MS),
    },
    "macos",
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
    soak: soakEvidence(runNumber),
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

  it("passes bounded release proof with one exact signed platform matrix", () => {
    const input = evidence();
    const manifests = input.manifests as Record<string, unknown>;
    const latestRun = (manifests.platformRuns as Array<Record<string, unknown>>)[2] as Record<
      string,
      unknown
    >;
    delete latestRun.soak;
    manifests.platformRuns = [latestRun];
    delete manifests.capability;
    delete manifests.review;
    delete manifests.soak;
    delete manifests.rollback;

    const result = evaluateReleasePromotionGate(input, gateOptions({ mode: "bounded" }));

    expect(result).toMatchObject({
      passed: true,
      reasonCodes: [],
      evidence: {
        mode: "bounded",
        observedPlatforms: ["linux", "macos", "windows"],
        qualifiedSoakRuns: 0,
      },
    });
  });

  it("keeps a missing platform blocking in bounded mode", () => {
    const input = evidence();
    const manifests = input.manifests as Record<string, unknown>;
    const latestRun = (manifests.platformRuns as Array<Record<string, unknown>>)[2] as Record<
      string,
      unknown
    >;
    delete latestRun.soak;
    delete (latestRun.platforms as Record<string, unknown>).windows;
    manifests.platformRuns = [latestRun];

    const result = evaluateReleasePromotionGate(input, gateOptions({ mode: "bounded" }));

    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain("platform_run_102_missing_windows");
  });

  it("fails closed for an unknown proof mode", () => {
    const result = evaluateReleasePromotionGate(
      evidence(),
      gateOptions({ mode: "invalid" as ReleasePromotionGateOptions["mode"] }),
    );

    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain("proof_mode_invalid");
  });
  it("loads split platform and soak manifests from one workflow run", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-release-evidence-"));
    const runDirectory = path.join(directory, "runs", "run-102");
    await mkdir(runDirectory, { recursive: true });
    try {
      await Promise.all([
        ...REQUIRED_PLATFORMS.map(async (name) => {
          await writeFile(
            path.join(runDirectory, `platform-${name}.json`),
            JSON.stringify(platform(name, 102)),
          );
        }),
        writeFile(path.join(runDirectory, "soak-evidence.json"), JSON.stringify(soakEvidence(102))),
        writeFile(
          path.join(runDirectory, "resource-macos.json"),
          JSON.stringify({ schemaVersion: 1, kind: "raw-resource-baseline" }),
        ),
        writeFile(
          path.join(runDirectory, "run-metadata.json"),
          JSON.stringify({
            runId: "102",
            runNumber: 102,
            sequence: 102,
            commitSha: EXPECTED.expectedCommitSha,
            generatedAt: new Date(NOW).toISOString(),
          }),
        ),
      ]);

      const loaded = await loadReleaseEvidenceDirectory(directory);
      const manifests = loaded.manifests as Record<string, unknown>;
      const runs = manifests.platformRuns as Array<Record<string, unknown>>;
      expect(runs).toHaveLength(1);
      expect(runs[0].soak).toMatchObject({
        kind: "release-soak-evidence",
        platform: "macos",
      });
      expect(Object.keys(runs[0].platforms as Record<string, unknown>).sort()).toEqual([
        "linux",
        "macos",
        "windows",
      ]);
      expect((runs[0].platforms as Record<string, Record<string, unknown>>).macos.kind).toBe(
        "release-platform-evidence",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects duplicate platform manifests for the same run", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-release-evidence-duplicate-"));
    const firstDirectory = path.join(directory, "runs", "run-102", "first");
    const secondDirectory = path.join(directory, "runs", "run-102", "second");
    await Promise.all([
      mkdir(firstDirectory, { recursive: true }),
      mkdir(secondDirectory, { recursive: true }),
    ]);
    try {
      const payload = JSON.stringify(platform("macos", 102));
      await Promise.all([
        writeFile(path.join(firstDirectory, "platform-macos.json"), payload),
        writeFile(path.join(secondDirectory, "platform-macos.json"), payload),
      ]);
      await expect(loadReleaseEvidenceDirectory(directory)).rejects.toThrow(
        "duplicate platform manifest for run 102 and macos",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
    const result = evaluateReleasePromotionGate(input, gateOptions({ requiredSoakRuns: 1 }));
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain("soak_insufficient_consecutive_runs");
    expect(result.evidence.requiredSoakRuns).toBe(3);
    expect(
      countConsecutiveQualifiedRuns([
        { runNumber: 100, qualified: true },
        { runNumber: 102, qualified: true },
        { runNumber: 104, qualified: true },
      ]),
    ).toBe(1);
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

  it("rejects promotion soak RSS slope above the recorded threshold", () => {
    const input = evidence();
    const manifests = input.manifests as Record<string, unknown>;
    const platformRuns = manifests.platformRuns as Array<Record<string, unknown>>;
    const latestSoakManifest = platformRuns[2].soak as Record<string, unknown>;
    const latestSoak = latestSoakManifest.soak as Record<string, unknown>;
    const rss = latestSoak.rss as Record<string, unknown>;
    const promotionGate = latestSoak.promotionGate as Record<string, unknown>;
    const rssSlope = promotionGate.rssSlope as Record<string, unknown>;
    const excessiveSlope = DEFAULT_MAX_PROMOTION_RSS_SLOPE_BYTES_PER_SECOND + 1;
    rss.slopeBytesPerSecond = excessiveSlope;
    rssSlope.observedBytesPerSecond = excessiveSlope;
    platformRuns[2].soak = signed(latestSoakManifest, "macos", "102", 102);
    expect(evaluateReleasePromotionGate(input, gateOptions()).reasonCodes).toContain(
      "soak_102_unqualified",
    );
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

  it("derives soak chronology and duration from authenticated soak manifests", () => {
    const input = evidence();
    const soak = (input.manifests as Record<string, unknown>).soak as Record<string, unknown>;
    const runs = soak.runs as Array<Record<string, unknown>>;
    const altered = runs[1];
    altered.runNumber = 104;
    altered.sequence = 104;
    altered.observedDurationMs = DEFAULT_REQUIRED_SOAK_DURATION_MS * 2;
    (altered.provenance as Record<string, unknown>).runNumber = 104;
    soak.sha256 = hashReleaseEvidence(soak);

    const result = evaluateReleasePromotionGate(input, gateOptions());

    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        "soak_run_2_run_number_mismatch",
        "soak_run_2_sequence_mismatch",
        "soak_run_2_duration_mismatch",
        "soak_run_2_provenance_run_number_mismatch",
      ]),
    );
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
  it("accepts a short platform matrix but rejects a short promotion soak", () => {
    expect(platformEvidenceQualifies(liveSoak(5_000), 5_000)).toBe(true);
    expect(
      platformSoakQualifies(liveSoak(5_000), "promotion", 5_000, DEFAULT_REQUIRED_SOAK_DURATION_MS),
    ).toBe(false);
    const forged = liveSoak(DEFAULT_REQUIRED_SOAK_DURATION_MS);
    (forged as { samples: unknown[] }).samples = [(forged as { samples: unknown[] }).samples[0]];
    (forged as { orphans: { cycles: unknown[] } }).orphans.cycles = [
      (forged as { orphans: { cycles: unknown[] } }).orphans.cycles[0],
    ];
    expect(
      platformSoakQualifies(
        forged,
        "promotion",
        DEFAULT_REQUIRED_SOAK_DURATION_MS,
        DEFAULT_REQUIRED_SOAK_DURATION_MS,
      ),
    ).toBe(false);

    const input = evidence();
    const runs = (input.manifests as Record<string, unknown>).platformRuns as Array<
      Record<string, unknown>
    >;
    runs[1].soak = signed(
      {
        schemaVersion: 1,
        kind: "release-soak-evidence",
        platform: "macos",
        status: "unclaimed",
        qualified: false,
        lane: "promotion",
        generatedAt: new Date(NOW).toISOString(),
        source: {
          workflow: EXPECTED.expectedWorkflow,
          artifactPath: "soak-evidence.json",
          commitSha: "abc123",
        },
        observedDurationMs: 5_000,
        requiredDurationMs: DEFAULT_REQUIRED_SOAK_DURATION_MS,
        soak: liveSoak(5_000),
      },
      "macos",
      "101",
      101,
    );
    const result = evaluateReleasePromotionGate(input, gateOptions());
    expect(result.reasonCodes).toContain("soak_101_unqualified");
    expect(result.reasonCodes).toContain("soak_insufficient_consecutive_runs");
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
                  sourceRepositoryURI: `https://github.com/${EXPECTED.expectedRepository}`,
                  sourceRepositoryIdentifier: "123456",
                  sourceRepositoryDigest: EXPECTED.expectedCommitSha,
                  sourceRepositoryRef: EXPECTED.expectedSourceRef,
                  runInvocationURI: "https://github.com/acme/oracle/actions/runs/100/attempts/1",
                  buildSignerURI: `https://github.com/${EXPECTED.expectedWorkflow}@${EXPECTED.expectedSourceRef}`,
                  issuer: "https://token.actions.githubusercontent.com",
                  certificateIssuer: "CN=sigstore-intermediate,O=sigstore.dev",
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
    const attestation = (input.attestations as Record<string, Record<string, unknown>>)[
      "100:linux"
    ];
    (attestation.pinned as Record<string, unknown>).repository = "attacker/oracle";
    expect(evaluateReleasePromotionGate(input, gateOptions()).reasonCodes).toContain(
      "platform_100_linux_attestation_pinned_repository_mismatch",
    );
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
