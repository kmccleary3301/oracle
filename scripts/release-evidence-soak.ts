import {
  DEFAULT_MAX_PROMOTION_RSS_SLOPE_BYTES_PER_SECOND,
  DEFAULT_REQUIRED_SOAK_DURATION_MS,
  isRecord,
  MAXIMUM_SOAK_SAMPLE_GAP_MS,
  numberValue,
  PROMOTION_RSS_NOISE_METHOD,
  PROMOTION_RSS_SLOPE_METHOD,
  type JsonRecord,
} from "./release-evidence-core.js";

function soakRecord(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  return isRecord(value.soak) ? value.soak : value;
}

export function soakDurationMs(value: unknown): number | null {
  const record = isRecord(value) ? value : null;
  const soak = soakRecord(value);
  const gate = soak && isRecord(soak.promotionGate) ? soak.promotionGate : null;
  return numberValue(record?.observedDurationMs ?? gate?.observedDurationMs ?? soak?.durationMs);
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

export function liveProcessSoakQualifies(value: unknown): boolean {
  const soak = soakRecord(value);
  if (!soak) return false;
  const chrome = isRecord(soak.chrome) ? soak.chrome : null;
  const cleanup = isRecord(soak.cleanup) ? soak.cleanup : null;
  const orphans = isRecord(soak.orphans) ? soak.orphans : null;
  const samples = Array.isArray(soak.samples) ? soak.samples : [];
  return (
    soak.realProcessSampling === true &&
    Boolean(chrome) &&
    chrome?.isolated === true &&
    chrome.headless === true &&
    numberValue(chrome.rootFoundSamples) !== null &&
    Number(chrome.rootFoundSamples) > 0 &&
    numberValue(chrome.nonzeroProcessSamples) !== null &&
    Number(chrome.nonzeroProcessSamples) > 0 &&
    chrome.cleanupConfirmed === true &&
    cleanup?.rootFound === false &&
    cleanup.processCount === 0 &&
    cleanCycles(orphans) &&
    samples.length > 0 &&
    samples.every(
      (sample) =>
        isRecord(sample) &&
        sample.rootFound === true &&
        Number(sample.processCount) > 0 &&
        Number(sample.rssBytes) > 0,
    )
  );
}

export function promotionSoakContinuityQualifies(
  value: unknown,
  requiredDurationMs: number,
): boolean {
  const soak = soakRecord(value);
  if (!soak) return false;
  const cleanup = isRecord(soak.cleanup) ? soak.cleanup : null;
  const samples = Array.isArray(soak.samples) ? soak.samples : [];
  const orphans = isRecord(soak.orphans) ? soak.orphans : null;
  const cycles = orphans && Array.isArray(orphans.cycles) ? orphans.cycles : [];
  const durationMs = numberValue(soak.durationMs);
  const requestedDurationMs = numberValue(soak.requestedDurationMs);
  const gate = isRecord(soak.promotionGate) ? soak.promotionGate : null;
  const gateDurationMs = numberValue(gate?.observedDurationMs);
  const rootPid = numberValue(soak.rootPid);
  if (
    durationMs === null ||
    requestedDurationMs === null ||
    gateDurationMs === null ||
    rootPid === null ||
    !Number.isInteger(rootPid) ||
    rootPid <= 0 ||
    durationMs < requiredDurationMs ||
    requestedDurationMs < requiredDurationMs ||
    gateDurationMs !== durationMs ||
    samples.length < 2 ||
    cycles.length !== samples.length ||
    numberValue(cleanup?.rootPid) !== rootPid
  )
    return false;
  const sampledAt = samples.map((sample) =>
    isRecord(sample) && numberValue(sample.sampledAtMs) !== null
      ? Number(sample.sampledAtMs)
      : Number.NaN,
  );
  if (
    sampledAt.some((sampledAtMs) => !Number.isFinite(sampledAtMs)) ||
    samples.some((sample) => !isRecord(sample) || numberValue(sample.rootPid) !== rootPid)
  )
    return false;
  const rss = isRecord(soak.rss) ? soak.rss : null;
  const rssSlope = gate && isRecord(gate.rssSlope) ? gate.rssSlope : null;
  const observedSlope = numberValue(rss?.slopeBytesPerSecond);
  const recordedSlope = numberValue(rssSlope?.observedBytesPerSecond);
  const maximumSlope = numberValue(rssSlope?.maxBytesPerSecond);
  const noiseBytes = numberValue(rss?.noiseBytes);
  const recordedNoiseBytes = numberValue(rssSlope?.noiseBytes);
  if (
    rssSlope?.method !== PROMOTION_RSS_SLOPE_METHOD ||
    rssSlope.noiseMethod !== PROMOTION_RSS_NOISE_METHOD ||
    observedSlope === null ||
    recordedSlope === null ||
    recordedSlope !== observedSlope ||
    maximumSlope !== DEFAULT_MAX_PROMOTION_RSS_SLOPE_BYTES_PER_SECOND ||
    observedSlope > DEFAULT_MAX_PROMOTION_RSS_SLOPE_BYTES_PER_SECOND ||
    noiseBytes === null ||
    noiseBytes < 0 ||
    recordedNoiseBytes !== noiseBytes
  )
    return false;
  for (let index = 1; index < sampledAt.length; index += 1) {
    const gap = sampledAt[index] - sampledAt[index - 1];
    if (gap <= 0 || gap > MAXIMUM_SOAK_SAMPLE_GAP_MS) return false;
  }
  return sampledAt.at(-1)! - sampledAt[0] >= requiredDurationMs - MAXIMUM_SOAK_SAMPLE_GAP_MS;
}

export function platformEvidenceQualifies(soak: unknown, observedDurationMs: number): boolean {
  return liveProcessSoakQualifies(soak) && observedDurationMs > 0;
}

export function platformSoakQualifies(
  soak: unknown,
  lane: string,
  observedDurationMs: number,
  requiredDurationMs = DEFAULT_REQUIRED_SOAK_DURATION_MS,
): boolean {
  return (
    lane === "promotion" &&
    liveProcessSoakQualifies(soak) &&
    promotionSoakContinuityQualifies(soak, requiredDurationMs) &&
    observedDurationMs >= requiredDurationMs
  );
}

export function countConsecutiveQualifiedRuns(
  runs: readonly Readonly<Record<string, unknown>>[],
): number {
  let longestStreak = 0;
  let currentStreak = 0;
  let previousRunNumber: number | null = null;
  for (const run of runs) {
    const runNumber = Number(run.runNumber);
    if (run.qualified !== true || !Number.isInteger(runNumber) || runNumber <= 0) {
      currentStreak = 0;
      previousRunNumber = null;
      continue;
    }
    currentStreak =
      previousRunNumber !== null && runNumber === previousRunNumber + 1 ? currentStreak + 1 : 1;
    previousRunNumber = runNumber;
    longestStreak = Math.max(longestStreak, currentStreak);
  }
  return longestStreak;
}
