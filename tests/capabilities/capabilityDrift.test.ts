import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCapabilityDriftAlert,
  buildCapabilityLedger,
  compareCapabilityBaselines,
  evaluateCapabilityPromotionGate,
  parseCapabilityProbe,
  writeDeterministicJson,
} from "../../src/capabilities/capabilityDrift.js";

const fixtureRoot = path.resolve("tests/fixtures/capability");

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(fixtureRoot, name), "utf8")) as unknown;
}

describe("capability baseline drift evidence", () => {
  it("redacts source values and emits only safe probe evidence", async () => {
    const result = parseCapabilityProbe(await fixture("baseline.json"));
    const serialized = writeDeterministicJson(result);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("fixture secret");
    expect(serialized).not.toContain("remoteChrome");
    expect(result.controls).toMatchObject({
      modes: ["chat", "work"],
      models: ["gpt-5.6"],
      effort: ["standard"],
    });
    expect(result.fingerprint.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reports additions without inventing arbitrary values", async () => {
    const comparison = compareCapabilityBaselines(
      await fixture("baseline.json"),
      await fixture("addition.json"),
    );
    expect(comparison.changes.additions).toEqual([
      "mode:search",
      "model:gpt-5.5",
      "upload:multiple",
    ]);
    expect(comparison.changes.removals).toEqual([]);
    const alert = buildCapabilityDriftAlert(comparison);
    expect(writeDeterministicJson(alert)).not.toContain("private");
    expect(alert.reasonCodes).toContain("control_added");
  });

  it("reports removals as a material regression", async () => {
    const comparison = compareCapabilityBaselines(
      await fixture("baseline.json"),
      await fixture("removal.json"),
    );
    expect(comparison.changes.removals).toEqual(["mode:work", "upload:file"]);
    expect(comparison.reasonCodes).toContain("control_removed");
    expect(comparison.materialRegression).toBe(true);
  });

  it("reports a hash-only change using hashes and no source values", async () => {
    const comparison = compareCapabilityBaselines(
      await fixture("baseline.json"),
      await fixture("hash-only.json"),
    );
    expect(comparison.changes.hashChanged).toBe(true);
    expect(comparison.changes.landmarkChanges).toEqual([]);
    expect(comparison.reasonCodes).toContain("fingerprint_changed");
    expect(writeDeterministicJson(buildCapabilityDriftAlert(comparison))).not.toContain("secret");
  });

  it("classifies unavailable probes as unsupported ledger evidence", async () => {
    const ledger = buildCapabilityLedger([
      {
        probe: await fixture("unsupported.json"),
        sourcePath: "tests/fixtures/capability/unsupported.json",
        platform: "linux",
      },
    ]);
    expect(ledger.entries).toHaveLength(6);
    expect(new Set(ledger.entries.map((entry) => entry.status))).toEqual(new Set(["unsupported"]));
    for (const entry of ledger.entries) {
      expect(entry.evidence).toEqual({
        capturedAt: "2026-08-10T12:04:00.000Z",
        fingerprint: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        sourcePath: "tests/fixtures/capability/unsupported.json",
      });
    }
    expect(writeDeterministicJson(ledger)).not.toContain("privateFailureDetail");
  });
});

describe("capability promotion gate", () => {
  it("fails closed when platform or release evidence is missing", () => {
    const result = evaluateCapabilityPromotionGate({ schemaVersion: 1, baselines: {} });
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toEqual([
      "independent_review_missing",
      "material_regressions_unknown",
      "missing_linux_baseline",
      "missing_macos_baseline",
      "missing_windows_baseline",
      "rollback_proof_missing",
      "soak_not_configured",
    ]);
  });

  it("passes with explicit cross-platform baselines and release gates", async () => {
    const probe = await fixture("baseline.json");
    const baselines = {
      macos: { sourcePath: "fixtures/macos.json", probe },
      linux: { sourcePath: "fixtures/linux.json", probe },
      windows: { sourcePath: "fixtures/windows.json", probe },
    };
    const result = evaluateCapabilityPromotionGate({
      schemaVersion: 1,
      baselines,
      soak: { configuredPasses: 3, passedPasses: 3 },
      review: { independentReviewPassed: true },
      rollback: { packagedRollbackProof: true },
      regressions: { materialRegressions: 0 },
    });
    expect(result.passed).toBe(true);
    expect(result.reasonCodes).toEqual([]);
    expect(result.evidence.baselines.macos?.fingerprint).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(writeDeterministicJson(result)).not.toContain("private");
  });
});
