import {
  validateProcessIdentity,
  type ProcessIdentityExpectation,
  type ProcessIdentityObservation,
  type ProcessIdentityValidation,
  type ProcessTreeSample,
} from "./resourceTelemetry.js";

export const RESOURCE_ACTIONS = [
  "admit",
  "pause_admission",
  "close_idle_targets",
  "schedule_recycle",
  "hard_stop",
  "remote_detach_only",
] as const;

export type ResourceAction = (typeof RESOURCE_ACTIONS)[number];
export type BrowserOwnership = "owned" | "adopted";
export type ResourceGovernorPhase = "normal" | "soft" | "resident_grace" | "hard";
export type ResourceGovernorOutcome = "resource_exhausted" | "resource_exhausted_unknown";
export type TrendDirection = "rising" | "falling" | "stable" | "unknown";

export interface ResourceGovernorConfig {
  /** Soft page ceiling. `maxPages` is accepted for the documented config spelling. */
  pageSoftCeiling?: number;
  maxPages?: number;
  /** Hard page ceiling. `hardMaxPages` is accepted for the documented config spelling. */
  pageHardCeiling?: number;
  hardMaxPages?: number;
  /** Optional process-tree RSS/working-set watermarks; these remain disabled until calibrated. */
  rssSoftBytes?: number | null;
  rssSoftLimit?: number | null;
  rssHardBytes?: number | null;
  rssHardLimit?: number | null;
  rssResumeBytes?: number | null;
  rssResumeLimit?: number | null;
  /** Bounded grace for a resident transaction at the hard watermark. */
  residentGraceMs?: number;
}

export interface ResolvedResourceGovernorConfig {
  pageSoftCeiling: number;
  pageHardCeiling: number;
  rssSoftBytes: number | null;
  rssHardBytes: number | null;
  rssResumeBytes: number | null;
  residentGraceMs: number;
}

export const DEFAULT_RESOURCE_GOVERNOR_CONFIG: ResolvedResourceGovernorConfig = {
  pageSoftCeiling: 2,
  pageHardCeiling: 3,
  rssSoftBytes: null,
  rssHardBytes: null,
  rssResumeBytes: null,
  residentGraceMs: 5_000,
};

export interface ResourceGovernorSample {
  /** Aggregated OS process-tree RSS/working-set bytes from resourceTelemetry. */
  rssBytes: number;
  /** Exact CDP target count, when available. Null means that the count is unavailable. */
  targetCount: number | null;
  sampledAtMs?: number;
  processCount?: number;
  cpuPercent?: number;
  cpuTimeMs?: number;
}

export interface ProcessIdentityEvidence {
  observed: ProcessIdentityObservation;
  expected: ProcessIdentityExpectation;
}

export interface ResidentTransaction {
  active: boolean;
  startedAtMs?: number;
}

export interface ResourceGovernorInput {
  sample: ResourceGovernorSample | ProcessTreeSample;
  ownership?: BrowserOwnership;
  browserOwnership?: BrowserOwnership;
  residentTransaction?: boolean | ResidentTransaction;
  identity?: ProcessIdentityEvidence;
  processIdentity?: ProcessIdentityEvidence;
  nowMs?: number;
}

export type ResourceDecisionReason =
  | "below_limits"
  | "hysteresis"
  | "page_soft_ceiling"
  | "rss_soft_watermark"
  | "page_hard_ceiling"
  | "rss_hard_watermark"
  | "resident_transaction_grace";

export interface ResourceDecision {
  action: ResourceAction;
  actions: readonly ResourceAction[];
  phase: ResourceGovernorPhase;
  reason: ResourceDecisionReason;
  canAdmit: boolean;
  terminationEligible: boolean;
  shouldTerminate: boolean;
  identityValidation: ProcessIdentityValidation | null;
  outcome?: ResourceGovernorOutcome;
  graceRemainingMs?: number;
}

export interface NumericTrend {
  first: number | null;
  last: number | null;
  delta: number | null;
  slopePerSecond: number | null;
  direction: TrendDirection;
}

export interface ResourceTrends {
  sampleCount: number;
  fromMs: number | null;
  toMs: number | null;
  rssBytes: NumericTrend;
  processCount: NumericTrend;
  cpuPercent: NumericTrend;
  cpuTimeMs: NumericTrend;
}

function finiteNumber(name: string, value: number, minimum = 0): number {
  if (!Number.isFinite(value) || value < minimum)
    throw new RangeError(`${name} must be a finite number >= ${minimum}`);
  return value;
}

function integerAtLeast(name: string, value: number, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum)
    throw new RangeError(`${name} must be an integer >= ${minimum}`);
  return value;
}

function chooseNumber(
  primary: number | undefined,
  alias: number | undefined,
  fallback: number,
): number {
  return primary ?? alias ?? fallback;
}

export function resolveResourceGovernorConfig(
  config: ResourceGovernorConfig = {},
): ResolvedResourceGovernorConfig {
  const pageSoftCeiling = integerAtLeast(
    "pageSoftCeiling",
    chooseNumber(
      config.pageSoftCeiling,
      config.maxPages,
      DEFAULT_RESOURCE_GOVERNOR_CONFIG.pageSoftCeiling,
    ),
    0,
  );
  const pageHardCeiling = integerAtLeast(
    "pageHardCeiling",
    chooseNumber(
      config.pageHardCeiling,
      config.hardMaxPages,
      DEFAULT_RESOURCE_GOVERNOR_CONFIG.pageHardCeiling,
    ),
    pageSoftCeiling,
  );
  const rssSoftCandidate = config.rssSoftBytes ?? config.rssSoftLimit;
  const rssHardCandidate = config.rssHardBytes ?? config.rssHardLimit;
  const rssResumeCandidate = config.rssResumeBytes ?? config.rssResumeLimit;
  const rssCandidates = [rssSoftCandidate, rssHardCandidate, rssResumeCandidate];
  const rssDisabled = rssCandidates.every((value) => value === undefined || value === null);
  let rssSoftBytes: number | null = null;
  let rssHardBytes: number | null = null;
  let rssResumeBytes: number | null = null;
  if (!rssDisabled) {
    if (rssSoftCandidate === undefined || rssSoftCandidate === null) {
      throw new RangeError(
        "rssSoftBytes, rssHardBytes, and rssResumeBytes must be configured together",
      );
    }
    if (rssHardCandidate === undefined || rssHardCandidate === null) {
      throw new RangeError(
        "rssSoftBytes, rssHardBytes, and rssResumeBytes must be configured together",
      );
    }
    if (rssResumeCandidate === undefined || rssResumeCandidate === null) {
      throw new RangeError(
        "rssSoftBytes, rssHardBytes, and rssResumeBytes must be configured together",
      );
    }
    rssSoftBytes = finiteNumber("rssSoftBytes", rssSoftCandidate);
    rssHardBytes = finiteNumber("rssHardBytes", rssHardCandidate);
    rssResumeBytes = finiteNumber("rssResumeBytes", rssResumeCandidate);
    if (rssHardBytes < rssSoftBytes) throw new RangeError("rssHardBytes must be >= rssSoftBytes");
    if (rssResumeBytes > rssSoftBytes)
      throw new RangeError("rssResumeBytes must be <= rssSoftBytes");
  }
  const residentGraceMs = finiteNumber(
    "residentGraceMs",
    config.residentGraceMs ?? DEFAULT_RESOURCE_GOVERNOR_CONFIG.residentGraceMs,
  );
  if (pageHardCeiling < pageSoftCeiling)
    throw new RangeError("pageHardCeiling must be >= pageSoftCeiling");
  return {
    pageSoftCeiling,
    pageHardCeiling,
    rssSoftBytes,
    rssHardBytes,
    rssResumeBytes,
    residentGraceMs,
  };
}

function numericValue(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

function trendFor(
  samples: readonly ResourceGovernorSample[],
  value: (sample: ResourceGovernorSample) => number | undefined,
): NumericTrend {
  let first: number | null = null;
  let last: number | null = null;
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  for (const sample of samples) {
    const current = numericValue(value(sample));
    if (current === null) continue;
    const at = numericValue(sample.sampledAtMs);
    if (first === null) {
      first = current;
      firstAt = at;
    }
    last = current;
    lastAt = at;
  }
  if (first === null || last === null) {
    return { first, last, delta: null, slopePerSecond: null, direction: "unknown" };
  }
  const delta = last - first;
  const elapsedMs = firstAt !== null && lastAt !== null ? lastAt - firstAt : null;
  const slopePerSecond = elapsedMs !== null && elapsedMs > 0 ? (delta * 1_000) / elapsedMs : null;
  const direction = delta > 0 ? "rising" : delta < 0 ? "falling" : "stable";
  return { first, last, delta, slopePerSecond, direction };
}

/** Compute trends from bounded process-tree samples; CDP contributes no memory signal here. */
export function calculateResourceTrends(
  samples: readonly (ResourceGovernorSample | ProcessTreeSample)[],
): ResourceTrends {
  const normalized = samples as readonly ResourceGovernorSample[];
  let fromMs: number | null = null;
  let toMs: number | null = null;
  for (const sample of normalized) {
    const timestamp = numericValue(sample.sampledAtMs);
    if (timestamp === null) continue;
    fromMs ??= timestamp;
    toMs = timestamp;
  }
  return {
    sampleCount: samples.length,
    fromMs,
    toMs,
    rssBytes: trendFor(normalized, (sample) => sample.rssBytes),
    processCount: trendFor(normalized, (sample) => sample.processCount),
    cpuPercent: trendFor(normalized, (sample) => sample.cpuPercent),
    cpuTimeMs: trendFor(normalized, (sample) => sample.cpuTimeMs),
  };
}

export const computeResourceTrends = calculateResourceTrends;

/** Keep the newest samples while guaranteeing the returned collection is bounded. */
export function retainBoundedSamples<T>(samples: readonly T[], maxSamples: number): readonly T[] {
  integerAtLeast("maxSamples", maxSamples, 0);
  if (samples.length <= maxSamples) return samples;
  return samples.slice(samples.length - maxSamples);
}

/** Evenly downsample a sample history while preserving both endpoints. */
export function downsampleSamples<T>(samples: readonly T[], maxSamples: number): readonly T[] {
  integerAtLeast("maxSamples", maxSamples, 0);
  if (maxSamples === 0 || samples.length === 0) return [];
  if (samples.length <= maxSamples) return samples;
  if (maxSamples === 1) return [samples[samples.length - 1]!];
  const result = new Array<T>(maxSamples);
  const denominator = maxSamples - 1;
  const sourceSpan = samples.length - 1;
  for (let index = 0; index < maxSamples; index += 1) {
    result[index] = samples[Math.round((index * sourceSpan) / denominator)]!;
  }
  return result;
}

export class BoundedSampleBuffer<T> {
  readonly #maxSamples: number;
  #samples: T[] = [];

  constructor(maxSamples: number) {
    this.#maxSamples = integerAtLeast("maxSamples", maxSamples, 1);
  }

  get size(): number {
    return this.#samples.length;
  }

  push(sample: T): void {
    this.#samples.push(sample);
    if (this.#samples.length > this.#maxSamples)
      this.#samples.splice(0, this.#samples.length - this.#maxSamples);
  }

  values(): readonly T[] {
    return this.#samples.slice();
  }

  clear(): void {
    this.#samples.length = 0;
  }
}

function activeResidentTransaction(value: boolean | ResidentTransaction | undefined): boolean {
  return typeof value === "boolean" ? value : value?.active === true;
}

function sampleTimestamp(input: ResourceGovernorInput): number {
  const candidate = input.nowMs ?? input.sample.sampledAtMs;
  return candidate !== undefined && Number.isFinite(candidate) ? candidate : 0;
}

function hardReason(pageHard: boolean): ResourceDecisionReason {
  return pageHard ? "page_hard_ceiling" : "rss_hard_watermark";
}

function softReason(pageSoft: boolean): ResourceDecisionReason {
  return pageSoft ? "page_soft_ceiling" : "rss_soft_watermark";
}

function identityForTermination(
  ownership: BrowserOwnership,
  evidence: ProcessIdentityEvidence | undefined,
): ProcessIdentityValidation | null {
  if (ownership !== "owned" || !evidence) return null;
  return validateProcessIdentity(evidence.observed, evidence.expected);
}

export class ResourceGovernor {
  readonly config: ResolvedResourceGovernorConfig;
  #phase: ResourceGovernorPhase = "normal";
  #residentGraceStartedAtMs: number | null = null;

  constructor(config: ResourceGovernorConfig = {}) {
    this.config = resolveResourceGovernorConfig(config);
  }

  get phase(): ResourceGovernorPhase {
    return this.#phase;
  }

  reset(): void {
    this.#phase = "normal";
    this.#residentGraceStartedAtMs = null;
  }

  decide(input: ResourceGovernorInput): ResourceDecision {
    const config = this.config;
    const sample = input.sample;
    const rssSoftLimit = config.rssSoftBytes;
    const rssHardLimit = config.rssHardBytes;
    const rssResumeLimit = config.rssResumeBytes;
    const rssEnabled = rssSoftLimit !== null && rssHardLimit !== null && rssResumeLimit !== null;
    const rssBytes = rssEnabled ? finiteNumber("sample.rssBytes", sample.rssBytes) : 0;
    const targetCount =
      sample.targetCount === null
        ? null
        : integerAtLeast("sample.targetCount", sample.targetCount, 0);
    const ownership = input.ownership ?? input.browserOwnership ?? "adopted";
    const resident = activeResidentTransaction(input.residentTransaction);
    const nowMs = sampleTimestamp(input);
    const pageHard = targetCount !== null && targetCount >= config.pageHardCeiling;
    const pageSoft = targetCount !== null && targetCount >= config.pageSoftCeiling;
    const rssHard = rssEnabled && rssBytes >= rssHardLimit;
    const rssSoft = rssEnabled && rssBytes >= rssSoftLimit;
    const hard = pageHard || rssHard;
    const soft = pageSoft || rssSoft;

    if (hard && ownership === "owned" && resident && config.residentGraceMs > 0) {
      if (this.#residentGraceStartedAtMs === null) this.#residentGraceStartedAtMs = nowMs;
      const graceRemainingMs = Math.max(
        0,
        this.#residentGraceStartedAtMs + config.residentGraceMs - nowMs,
      );
      if (graceRemainingMs > 0) {
        this.#phase = "resident_grace";
        return {
          action: "pause_admission",
          actions: ["pause_admission", "close_idle_targets"],
          phase: this.#phase,
          reason: "resident_transaction_grace",
          canAdmit: false,
          terminationEligible: false,
          shouldTerminate: false,
          identityValidation: null,
          graceRemainingMs,
        };
      }
    } else if (!hard || !resident || ownership !== "owned") {
      this.#residentGraceStartedAtMs = null;
    }

    if (hard) {
      this.#phase = "hard";
      const hardStop = ownership === "owned";
      const identityValidation = hardStop
        ? identityForTermination(ownership, input.identity ?? input.processIdentity)
        : null;
      const terminationEligible = hardStop && identityValidation?.eligible === true;
      return {
        action: hardStop ? "hard_stop" : "remote_detach_only",
        actions: hardStop
          ? ["pause_admission", "hard_stop"]
          : ["pause_admission", "remote_detach_only"],
        phase: this.#phase,
        reason: hardReason(pageHard),
        canAdmit: false,
        terminationEligible,
        shouldTerminate: terminationEligible,
        identityValidation,
        ...(resident
          ? { outcome: "resource_exhausted_unknown" as const, graceRemainingMs: 0 }
          : { outcome: "resource_exhausted" as const }),
      };
    }
    const pageClear = targetCount === null || targetCount < config.pageSoftCeiling;
    const rssClear = !rssEnabled || rssBytes <= rssResumeLimit;
    const resume = !soft && pageClear && rssClear;
    if (this.#phase !== "normal" && !resume) {
      this.#phase = "soft";
      return {
        action: "pause_admission",
        actions:
          ownership === "owned"
            ? ["pause_admission", "close_idle_targets", "schedule_recycle"]
            : ["pause_admission", "close_idle_targets", "remote_detach_only"],
        phase: this.#phase,
        reason: soft ? softReason(pageSoft) : "hysteresis",
        canAdmit: false,
        terminationEligible: false,
        shouldTerminate: false,
        identityValidation: null,
      };
    }

    this.#residentGraceStartedAtMs = null;
    this.#phase = soft ? "soft" : "normal";
    if (soft) {
      return {
        action: "pause_admission",
        actions:
          ownership === "owned"
            ? ["pause_admission", "close_idle_targets", "schedule_recycle"]
            : ["pause_admission", "close_idle_targets", "remote_detach_only"],
        phase: this.#phase,
        reason: softReason(pageSoft),
        canAdmit: false,
        terminationEligible: false,
        shouldTerminate: false,
        identityValidation: null,
      };
    }
    return {
      action: "admit",
      actions: ["admit"],
      phase: this.#phase,
      reason: "below_limits",
      canAdmit: true,
      terminationEligible: false,
      shouldTerminate: false,
      identityValidation: null,
    };
  }
}

export function evaluateResourceDecision(
  input: ResourceGovernorInput,
  config: ResourceGovernorConfig = {},
): ResourceDecision {
  return new ResourceGovernor(config).decide(input);
}

/** Construct a stateful governor for one browser generation. */
export function createResourceGovernor(config: ResourceGovernorConfig = {}): ResourceGovernor {
  return new ResourceGovernor(config);
}
