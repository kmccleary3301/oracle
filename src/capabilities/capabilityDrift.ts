import { createHash } from "node:crypto";
import type { ChatgptCapabilityProbeResult } from "../browser/chatgpt/types.js";

export const CAPABILITY_EVIDENCE_SCHEMA_VERSION = 1 as const;

const SAFE_MODES = ["chat", "deep-research", "images", "search", "work"] as const;
const SAFE_MODELS = [
  "claude",
  "gemini",
  "gpt-4o",
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6",
  "o-series",
] as const;
const SAFE_EFFORT = [
  "extended",
  "extra-high",
  "heavy",
  "high",
  "light",
  "medium",
  "pro",
  "standard",
] as const;
const SAFE_LANDMARKS = [
  "readyState",
  "landmarkCount",
  "buttonCount",
  "inputCount",
  "linkCount",
  "dialogCount",
  "menuCount",
] as const;
const SAFE_UPLOADS = ["file", "image", "multiple"] as const;
const SAFE_STATUSES = [
  "ok",
  "login_required",
  "challenge_required",
  "unknown",
  "unavailable",
] as const;
const SAFE_FAILURE_CODES = [
  "configuration_missing",
  "connection_failed",
  "navigation_failed",
  "evaluation_failed",
  "invalid_observation",
  "unknown",
] as const;
const SAFE_READY_STATES = ["loading", "interactive", "complete", "unknown"] as const;
const ADAPTER_FALLBACK = "unknown";

export type CapabilityStatus = (typeof SAFE_STATUSES)[number];
export type CapabilityFailureCode = (typeof SAFE_FAILURE_CODES)[number];
export type CapabilityLedgerStatus =
  | "supported"
  | "partial"
  | "unsupported"
  | "blocked"
  | "unverified";
export type CapabilityPlatform = "macos" | "linux" | "windows" | "unknown";

export interface CapabilityControls {
  modes: string[];
  models: string[];
  effort: string[];
  uploads: {
    file: boolean;
    image: boolean;
    multiple: boolean;
  };
}

export interface CapabilityLandmarks {
  readyState: (typeof SAFE_READY_STATES)[number];
  landmarkCount: number;
  buttonCount: number;
  inputCount: number;
  linkCount: number;
  dialogCount: number;
  menuCount: number;
}

/** The only probe fields allowed in drift output. */
export interface SanitizedCapabilityEvidence {
  capturedAt: string;
  adapterVersion: string;
  status: CapabilityStatus;
  failure?: { code: CapabilityFailureCode };
  controls: CapabilityControls;
  landmarks: CapabilityLandmarks;
  fingerprint: {
    algorithm: "sha256";
    hash: string;
  };
}

export interface CapabilityProbeEnvelope {
  schemaVersion: typeof CAPABILITY_EVIDENCE_SCHEMA_VERSION;
  probe: ChatgptCapabilityProbeResult;
  sourcePath?: string;
  platform?: CapabilityPlatform;
}

export interface CapabilityDriftChanges {
  additions: string[];
  removals: string[];
  landmarkChanges: Array<{
    name: (typeof SAFE_LANDMARKS)[number];
    baseline: number | string;
    current: number | string;
  }>;
  hashChanged: boolean;
  statusChanged: boolean;
  adapterChanged: boolean;
}

export type CapabilityDriftReasonCode =
  | "adapter_version_changed"
  | "status_changed"
  | "failure_code_changed"
  | "control_added"
  | "control_removed"
  | "landmark_changed"
  | "fingerprint_changed"
  | "baseline_not_healthy"
  | "current_not_healthy";

export interface CapabilityBaselineComparison {
  schemaVersion: typeof CAPABILITY_EVIDENCE_SCHEMA_VERSION;
  kind: "chatgpt-capability-baseline-comparison";
  baseline: SanitizedCapabilityEvidence;
  current: SanitizedCapabilityEvidence;
  changes: CapabilityDriftChanges;
  reasonCodes: CapabilityDriftReasonCode[];
  materialRegression: boolean;
}

export interface CapabilityDriftAlert {
  schemaVersion: typeof CAPABILITY_EVIDENCE_SCHEMA_VERSION;
  kind: "chatgpt-capability-drift-alert";
  adapterVersion: string;
  baseline: SanitizedCapabilityEvidence;
  current: SanitizedCapabilityEvidence;
  reasonCodes: CapabilityDriftReasonCode[];
  changes: CapabilityDriftChanges;
  materialRegression: boolean;
}

export interface CapabilityEvidenceReference {
  capturedAt: string;
  fingerprint: string;
  sourcePath: string;
}

export interface CapabilityLedgerEntry {
  capability: string;
  platform: CapabilityPlatform;
  status: CapabilityLedgerStatus;
  adapterVersion: string;
  controls: string[];
  evidence: CapabilityEvidenceReference;
}

export interface CapabilityLedger {
  schemaVersion: typeof CAPABILITY_EVIDENCE_SCHEMA_VERSION;
  kind: "chatgpt-capability-ledger";
  entries: CapabilityLedgerEntry[];
}

export interface CapabilityLedgerInput {
  probe: unknown;
  sourcePath: string;
  platform?: CapabilityPlatform | string;
}

export interface PromotionBaselineInput {
  sourcePath: string;
  probe: unknown;
}

export interface PromotionEvidenceInput {
  schemaVersion?: unknown;
  baselines?: Record<string, unknown>;
  soak?: unknown;
  review?: unknown;
  rollback?: unknown;
  regressions?: unknown;
  comparisons?: unknown;
}

export interface PromotionGateResult {
  schemaVersion: typeof CAPABILITY_EVIDENCE_SCHEMA_VERSION;
  kind: "chatgpt-capability-promotion-gate";
  passed: boolean;
  reasonCodes: string[];
  evidence: {
    baselines: Record<CapabilityPlatform, CapabilityEvidenceReference | null>;
    soak: { configuredPasses: number; passedPasses: number };
    independentReviewPassed: boolean;
    packagedRollbackProof: boolean;
    materialRegressions: number | null;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

function safeList(value: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  const allow = new Set(allowed);
  return [
    ...new Set(value.filter((item): item is string => typeof item === "string" && allow.has(item))),
  ].sort();
}

function safeBoolean(value: unknown): boolean {
  return value === true;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100_000, Math.floor(value)))
    : 0;
}

function safeCapturedAt(value: unknown): string {
  const candidate = stringValue(value);
  if (!candidate) return "1970-01-01T00:00:00.000Z";
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "1970-01-01T00:00:00.000Z";
}

function safeAdapterVersion(value: unknown): string {
  const candidate = stringValue(value);
  if (!candidate || candidate.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate)) {
    return ADAPTER_FALLBACK;
  }
  return candidate;
}

function safeStatus(value: unknown): CapabilityStatus {
  return (SAFE_STATUSES as readonly string[]).includes(value as string)
    ? (value as CapabilityStatus)
    : "unknown";
}

function safeFailureCode(value: unknown): CapabilityFailureCode | undefined {
  return (SAFE_FAILURE_CODES as readonly string[]).includes(value as string)
    ? (value as CapabilityFailureCode)
    : undefined;
}

function safeReadyState(value: unknown): CapabilityLandmarks["readyState"] {
  return (SAFE_READY_STATES as readonly string[]).includes(value as string)
    ? (value as CapabilityLandmarks["readyState"])
    : "unknown";
}

function readObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readFailure(value: unknown): CapabilityFailureCode | undefined {
  const record = readObject(value);
  return safeFailureCode(record.code);
}

function readLandmarks(value: unknown): CapabilityLandmarks {
  const structure = readObject(value);
  return {
    readyState: safeReadyState(structure.readyState),
    landmarkCount: safeCount(structure.landmarkCount),
    buttonCount: safeCount(structure.buttonCount),
    inputCount: safeCount(structure.inputCount),
    linkCount: safeCount(structure.linkCount),
    dialogCount: safeCount(structure.dialogCount),
    menuCount: safeCount(structure.menuCount),
  };
}

function hashLandmarks(landmarks: CapabilityLandmarks): string {
  return createHash("sha256").update(JSON.stringify(landmarks)).digest("hex");
}

function safeHash(value: unknown, landmarks: CapabilityLandmarks): string {
  const candidate = stringValue(value);
  return candidate && /^[a-f0-9]{64}$/i.test(candidate)
    ? candidate.toLowerCase()
    : hashLandmarks(landmarks);
}

/** Parse and redact a probe without retaining unknown source properties. */
export function parseCapabilityProbe(value: unknown): SanitizedCapabilityEvidence {
  if (!isRecord(value)) throw new Error("invalid capability probe");
  if (value.schemaVersion !== CAPABILITY_EVIDENCE_SCHEMA_VERSION) {
    throw new Error("unsupported capability probe schema");
  }
  const controls = readObject(value.controls);
  const uploads = readObject(controls.uploads);
  const fingerprint = readObject(value.fingerprint);
  const landmarks = readLandmarks(fingerprint.structure);
  const failure = readFailure(value.failure);
  const result: SanitizedCapabilityEvidence = {
    capturedAt: safeCapturedAt(value.capturedAt),
    adapterVersion: safeAdapterVersion(value.adapterVersion),
    status: safeStatus(value.status),
    controls: {
      modes: safeList(controls.modes, SAFE_MODES),
      models: safeList(controls.models, SAFE_MODELS),
      effort: safeList(controls.effort, SAFE_EFFORT),
      uploads: {
        file: safeBoolean(uploads.file),
        image: safeBoolean(uploads.image),
        multiple: safeBoolean(uploads.multiple),
      },
    },
    landmarks,
    fingerprint: {
      algorithm: "sha256",
      hash: safeHash(fingerprint.hash, landmarks),
    },
  };
  if (failure) result.failure = { code: failure };
  return result;
}

/** Parse JSON text and return the same deterministic, redacted evidence as parseCapabilityProbe. */
export function parseCapabilityProbeJson(text: string): SanitizedCapabilityEvidence {
  try {
    return parseCapabilityProbe(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("invalid capability probe JSON");
    throw error;
  }
}

export function writeDeterministicJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function controlsForComparison(evidence: SanitizedCapabilityEvidence): string[] {
  const controls = [
    ...evidence.controls.modes.map((value) => `mode:${value}`),
    ...evidence.controls.models.map((value) => `model:${value}`),
    ...evidence.controls.effort.map((value) => `effort:${value}`),
    ...SAFE_UPLOADS.filter((name) => evidence.controls.uploads[name]).map(
      (name) => `upload:${name}`,
    ),
  ];
  return controls.sort();
}

function failureCode(evidence: SanitizedCapabilityEvidence): CapabilityFailureCode | null {
  return evidence.failure?.code ?? null;
}

function compareSets(
  baseline: string[],
  current: string[],
): { additions: string[]; removals: string[] } {
  const oldSet = new Set(baseline);
  const newSet = new Set(current);
  return {
    additions: current.filter((item) => !oldSet.has(item)).sort(),
    removals: baseline.filter((item) => !newSet.has(item)).sort(),
  };
}

export function compareCapabilityBaselines(
  baselineValue: unknown,
  currentValue: unknown,
): CapabilityBaselineComparison {
  const baseline = parseCapabilityProbe(baselineValue);
  const current = parseCapabilityProbe(currentValue);
  const setChanges = compareSets(controlsForComparison(baseline), controlsForComparison(current));
  const landmarkChanges = SAFE_LANDMARKS.flatMap((name) =>
    baseline.landmarks[name] !== current.landmarks[name]
      ? [{ name, baseline: baseline.landmarks[name], current: current.landmarks[name] }]
      : [],
  );
  const hashChanged = baseline.fingerprint.hash !== current.fingerprint.hash;
  const statusChanged = baseline.status !== current.status;
  const adapterChanged = baseline.adapterVersion !== current.adapterVersion;
  const reasonCodes: CapabilityDriftReasonCode[] = [];
  if (adapterChanged) reasonCodes.push("adapter_version_changed");
  if (statusChanged) reasonCodes.push("status_changed");
  if (failureCode(baseline) !== failureCode(current)) reasonCodes.push("failure_code_changed");
  if (setChanges.additions.length > 0) reasonCodes.push("control_added");
  if (setChanges.removals.length > 0) reasonCodes.push("control_removed");
  if (landmarkChanges.length > 0) reasonCodes.push("landmark_changed");
  if (hashChanged) reasonCodes.push("fingerprint_changed");
  if (baseline.status !== "ok") reasonCodes.push("baseline_not_healthy");
  if (current.status !== "ok") reasonCodes.push("current_not_healthy");
  const materialRegression =
    setChanges.removals.length > 0 ||
    landmarkChanges.some(({ name, baseline: oldValue, current: newValue }) =>
      name === "readyState"
        ? oldValue === "complete" && newValue !== "complete"
        : Number(newValue) < Number(oldValue),
    ) ||
    hashChanged ||
    (statusChanged && current.status !== "ok") ||
    current.status !== "ok" ||
    adapterChanged;
  return {
    schemaVersion: CAPABILITY_EVIDENCE_SCHEMA_VERSION,
    kind: "chatgpt-capability-baseline-comparison",
    baseline,
    current,
    changes: {
      additions: setChanges.additions,
      removals: setChanges.removals,
      landmarkChanges,
      hashChanged,
      statusChanged,
      adapterChanged,
    },
    reasonCodes,
    materialRegression,
  };
}

export function buildCapabilityDriftAlert(
  comparison: CapabilityBaselineComparison,
): CapabilityDriftAlert {
  return {
    schemaVersion: CAPABILITY_EVIDENCE_SCHEMA_VERSION,
    kind: "chatgpt-capability-drift-alert",
    adapterVersion: comparison.current.adapterVersion,
    baseline: comparison.baseline,
    current: comparison.current,
    reasonCodes: [...comparison.reasonCodes],
    changes: comparison.changes,
    materialRegression: comparison.materialRegression,
  };
}

function normalizePlatform(value: unknown): CapabilityPlatform {
  const platform = stringValue(value)?.toLowerCase();
  if (platform === "macos" || platform === "darwin" || platform === "mac") return "macos";
  if (platform === "linux") return "linux";
  if (platform === "windows" || platform === "win32" || platform === "win") return "windows";
  return "unknown";
}

function classifyProbe(
  evidence: SanitizedCapabilityEvidence,
  controls: string[],
): CapabilityLedgerStatus {
  if (evidence.status === "unavailable") return "unsupported";
  if (evidence.status === "login_required" || evidence.status === "challenge_required")
    return "blocked";
  if (evidence.status !== "ok") return "unverified";
  return controls.length > 0 ? "supported" : "partial";
}

function evidenceReference(
  evidence: SanitizedCapabilityEvidence,
  sourcePath: string,
): CapabilityEvidenceReference {
  const safePath = sourcePath
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 512);
  return {
    capturedAt: evidence.capturedAt,
    fingerprint: evidence.fingerprint.hash,
    sourcePath: safePath || "<unspecified>",
  };
}

export function buildCapabilityLedger(inputs: readonly CapabilityLedgerInput[]): CapabilityLedger {
  const entries: CapabilityLedgerEntry[] = [];
  for (const input of inputs) {
    const evidence = parseCapabilityProbe(input.probe);
    const platform = normalizePlatform(input.platform);
    const reference = evidenceReference(evidence, input.sourcePath);
    const values: Array<[string, string[]]> = [
      ["modes", evidence.controls.modes],
      ["models", evidence.controls.models],
      ["effort", evidence.controls.effort],
      ["uploads.file", evidence.controls.uploads.file ? ["file"] : []],
      ["uploads.image", evidence.controls.uploads.image ? ["image"] : []],
      ["uploads.multiple", evidence.controls.uploads.multiple ? ["multiple"] : []],
    ];
    for (const [capability, controls] of values) {
      entries.push({
        capability,
        platform,
        status: classifyProbe(evidence, controls),
        adapterVersion: evidence.adapterVersion,
        controls: [...controls],
        evidence: reference,
      });
    }
  }
  entries.sort((left, right) =>
    `${left.platform}\u0000${left.capability}\u0000${left.evidence.sourcePath}`.localeCompare(
      `${right.platform}\u0000${right.capability}\u0000${right.evidence.sourcePath}`,
    ),
  );
  return {
    schemaVersion: CAPABILITY_EVIDENCE_SCHEMA_VERSION,
    kind: "chatgpt-capability-ledger",
    entries,
  };
}
function readBoolean(record: Record<string, unknown>, names: readonly string[]): boolean {
  return names.some((name) => record[name] === true);
}

function readNumber(record: Record<string, unknown>, names: readonly string[]): number | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  }
  return null;
}

function normalizeBaselineEntry(value: unknown): PromotionBaselineInput | null {
  if (!isRecord(value)) return null;
  const sourcePath = stringValue(value.sourcePath) ?? stringValue(value.path);
  const probe = value.probe ?? value.evidence;
  if (!sourcePath || !probe) return null;
  return { sourcePath: sourcePath.slice(0, 512), probe };
}

function readBaseline(
  baselines: Record<string, unknown> | undefined,
  names: readonly string[],
): PromotionBaselineInput | null {
  if (!baselines) return null;
  for (const name of names) {
    const entry = normalizeBaselineEntry(baselines[name]);
    if (entry) return entry;
  }
  return null;
}

function readMaterialRegressions(input: PromotionEvidenceInput): number | null {
  const regressions = readObject(input.regressions);
  const explicit = readNumber(regressions, ["materialRegressions", "material", "count"]);
  if (explicit !== null) return explicit;
  const topLevel = readNumber(input as unknown as Record<string, unknown>, ["materialRegressions"]);
  if (topLevel !== null) return topLevel;
  if (regressions.zeroMaterialRegressions === true || input.regressions === 0) return 0;
  if (Array.isArray(input.comparisons)) {
    let count = 0;
    for (const comparison of input.comparisons) {
      if (isRecord(comparison) && comparison.materialRegression === true) count += 1;
    }
    return count;
  }
  return null;
}

function referenceForBaseline(
  input: PromotionBaselineInput | null,
): CapabilityEvidenceReference | null {
  if (!input) return null;
  try {
    const evidence = parseCapabilityProbe(input.probe);
    return evidenceReference(evidence, input.sourcePath);
  } catch {
    return null;
  }
}

/** Evaluate promotion evidence fail-closed and emit only fixed reason codes and safe evidence. */
export function evaluateCapabilityPromotionGate(value: unknown): PromotionGateResult {
  const input = isRecord(value) ? (value as PromotionEvidenceInput) : {};
  const baselines = isRecord(input.baselines) ? input.baselines : undefined;
  const macos = readBaseline(baselines, ["macos", "macOS", "darwin", "mac"]);
  const linux = readBaseline(baselines, ["linux"]);
  const windows = readBaseline(baselines, ["windows", "Windows", "win32", "win"]);
  const references = {
    macos: referenceForBaseline(macos),
    linux: referenceForBaseline(linux),
    windows: referenceForBaseline(windows),
    unknown: null,
  } as Record<CapabilityPlatform, CapabilityEvidenceReference | null>;
  const reasons: string[] = [];
  const statusByPlatform: Array<[string, PromotionBaselineInput | null]> = [
    ["macos", macos],
    ["linux", linux],
    ["windows", windows],
  ];
  for (const [platform, baseline] of statusByPlatform) {
    if (!baseline) {
      reasons.push(`missing_${platform}_baseline`);
      continue;
    }
    try {
      const evidence = parseCapabilityProbe(baseline.probe);
      if (evidence.status !== "ok") reasons.push(`${platform}_baseline_not_supported`);
    } catch {
      reasons.push(`${platform}_baseline_invalid`);
    }
  }
  const soak = readObject(input.soak);
  const configuredPasses = readNumber(soak, [
    "configuredPasses",
    "passesConfigured",
    "requiredPasses",
  ]);
  const passedPasses = readNumber(soak, ["passedPasses", "passesPassed", "passesCompleted"]);
  const safeConfigured = configuredPasses ?? 0;
  const safePassed = passedPasses ?? 0;
  if (safeConfigured < 1) reasons.push("soak_not_configured");
  else if (safePassed < safeConfigured) reasons.push("soak_incomplete");
  const review = readObject(input.review);
  const independentReviewPassed = readBoolean(review, [
    "independentReviewPassed",
    "passed",
    "independent",
  ]);
  if (!independentReviewPassed) reasons.push("independent_review_missing");
  const rollback = readObject(input.rollback);
  const packagedRollbackProof = readBoolean(rollback, [
    "packagedRollbackProof",
    "packaged",
    "proof",
    "passed",
  ]);
  if (!packagedRollbackProof) reasons.push("rollback_proof_missing");
  const materialRegressions = readMaterialRegressions(input);
  if (materialRegressions === null) reasons.push("material_regressions_unknown");
  else if (materialRegressions !== 0) reasons.push("material_regressions_present");
  if (
    input.schemaVersion !== undefined &&
    input.schemaVersion !== CAPABILITY_EVIDENCE_SCHEMA_VERSION
  ) {
    reasons.push("invalid_evidence_schema");
  }
  const uniqueReasons = [...new Set(reasons)].sort();
  return {
    schemaVersion: CAPABILITY_EVIDENCE_SCHEMA_VERSION,
    kind: "chatgpt-capability-promotion-gate",
    passed: uniqueReasons.length === 0,
    reasonCodes: uniqueReasons,
    evidence: {
      baselines: references,
      soak: { configuredPasses: safeConfigured, passedPasses: safePassed },
      independentReviewPassed,
      packagedRollbackProof,
      materialRegressions,
    },
  };
}

export function parseCapabilityPromotionEvidenceJson(text: string): PromotionGateResult {
  try {
    return evaluateCapabilityPromotionGate(JSON.parse(text) as unknown);
  } catch {
    return evaluateCapabilityPromotionGate({ invalid: true });
  }
}
