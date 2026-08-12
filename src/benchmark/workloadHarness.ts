import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const WORKLOAD_KINDS = ["chat", "upload", "image", "research", "work"] as const;
export type WorkloadKind = (typeof WORKLOAD_KINDS)[number];

export const BENCHMARK_MODES = ["baseline", "soak"] as const;
export type BenchmarkMode = (typeof BENCHMARK_MODES)[number];

export const LIFECYCLE_FAULT_KINDS = [
  "browser_disconnect",
  "renderer_crash",
  "controller_sigkill",
  "gpu_crash",
  "cleanup_timeout",
] as const;
export type LifecycleFaultKind = (typeof LIFECYCLE_FAULT_KINDS)[number];

export const LIFECYCLE_FAULT_PHASES = ["before", "during", "after"] as const;
export type LifecycleFaultPhase = (typeof LIFECYCLE_FAULT_PHASES)[number];

export type InputShape = "none" | "short" | "long";

export interface LifecycleFaultDescriptor {
  kind: LifecycleFaultKind;
  phase: LifecycleFaultPhase;
  iteration?: number;
  afterMs?: number;
}

/** A descriptor intentionally contains workload shape, never prompt/file/account content. */
export interface WorkloadScenarioDescriptor {
  id: string;
  kind: WorkloadKind;
  operation: string;
  iterations: number;
  concurrency: number;
  inputShape: InputShape;
  attachmentCount?: number;
  attachmentBytes?: number;
  durationMs?: number;
  faults: readonly LifecycleFaultDescriptor[];
}

export interface BenchmarkConfig {
  schemaVersion: 1;
  mode: BenchmarkMode;
  sampleIntervalMs: number;
  runDurationMs?: number;
  scenarios: readonly WorkloadScenarioDescriptor[];
}

export interface BenchmarkResourceSample {
  sampledAt?: string;
  sampledAtMs?: number;
  targetCount?: number | null;
  processCount?: number;
  rssBytes?: number;
  workingSetBytes?: number;
  cpuPercent?: number;
  cpuTimeMs?: number;
}

export type WorkloadResultStatus = "completed" | "failed" | "faulted";

export interface WorkloadExecutionResult {
  status: WorkloadResultStatus;
  reasonCode?: string;
}

export interface WorkloadExecutionContext {
  readonly mode: BenchmarkMode;
  readonly scenario: WorkloadScenarioDescriptor;
  readonly iteration: number;
}

export interface BenchmarkRunOptions {
  outputDir?: string;
  now?: () => Date;
  sampleResource?: (
    context: WorkloadExecutionContext,
  ) => Promise<BenchmarkResourceSample | undefined>;
  executeScenario: (
    scenario: WorkloadScenarioDescriptor,
    context: WorkloadExecutionContext,
  ) => Promise<WorkloadExecutionResult>;
}

export interface SummaryMetric {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  p95: number | null;
}

export interface ScenarioRunSummary {
  id: string;
  kind: WorkloadKind;
  iterations: number;
  completed: number;
  failed: number;
  faulted: number;
}

export interface BenchmarkSummary {
  schemaVersion: 1;
  mode: BenchmarkMode;
  startedAt: string;
  endedAt: string;
  scenarioCount: number;
  iterationCount: number;
  completed: number;
  failed: number;
  faulted: number;
  resources: {
    targetCount: SummaryMetric;
    processCount: SummaryMetric;
    rssBytes: SummaryMetric;
    workingSetBytes: SummaryMetric;
    cpuPercent: SummaryMetric;
    cpuTimeMs: SummaryMetric;
  };
  scenarios: readonly ScenarioRunSummary[];
}

export interface BenchmarkArtifactPaths {
  eventsPath: string;
  summaryPath: string;
}

export interface BenchmarkRunResult {
  summary: BenchmarkSummary;
  artifacts?: BenchmarkArtifactPaths;
}

const WORKLOAD_OPERATION_VALUES: Record<WorkloadKind, readonly string[]> = {
  chat: ["create", "followup"],
  upload: ["single", "multiple", "large-stream"],
  image: ["generate", "edit"],
  research: ["start", "approve-plan", "interrupt"],
  work: ["start", "followup", "interrupt"],
};

const SENSITIVE_KEY =
  /(?:prompt|message|content|conversation|account|cookie|secret|password|credential|authorization|token|private|email|title|filename|filepath|user.?data.?dir)/i;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REASON_CODE = /^[a-z][a-z0-9._-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains unsupported field ${key}`);
    if (SENSITIVE_KEY.test(key)) throw new Error(`${label} contains a private field`);
  }
}

function parseBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  fallback?: number,
): number {
  const candidate = value === undefined ? fallback : value;
  if (
    typeof candidate !== "number" ||
    !Number.isInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return candidate;
}

function parseFault(input: unknown, label: string): LifecycleFaultDescriptor {
  if (!isRecord(input)) throw new Error(`${label} must be an object`);
  assertAllowedKeys(input, ["kind", "phase", "iteration", "afterMs"], label);
  const kind = input.kind;
  const phase = input.phase;
  if (!LIFECYCLE_FAULT_KINDS.includes(kind as LifecycleFaultKind))
    throw new Error(`${label}.kind is unsupported`);
  if (!LIFECYCLE_FAULT_PHASES.includes(phase as LifecycleFaultPhase))
    throw new Error(`${label}.phase is unsupported`);
  const result: LifecycleFaultDescriptor = {
    kind: kind as LifecycleFaultKind,
    phase: phase as LifecycleFaultPhase,
  };
  if (input.iteration !== undefined)
    result.iteration = parseBoundedInteger(input.iteration, `${label}.iteration`, 0, 1_000_000);
  if (input.afterMs !== undefined)
    result.afterMs = parseBoundedInteger(input.afterMs, `${label}.afterMs`, 0, 86_400_000);
  return result;
}

function parseScenario(input: unknown, index: number): WorkloadScenarioDescriptor {
  const label = `scenarios[${index}]`;
  if (!isRecord(input)) throw new Error(`${label} must be an object`);
  assertAllowedKeys(
    input,
    [
      "id",
      "kind",
      "operation",
      "iterations",
      "concurrency",
      "inputShape",
      "attachmentCount",
      "attachmentBytes",
      "durationMs",
      "faults",
    ],
    label,
  );
  if (typeof input.id !== "string" || !SAFE_ID.test(input.id))
    throw new Error(`${label}.id must be a safe identifier`);
  if (!WORKLOAD_KINDS.includes(input.kind as WorkloadKind))
    throw new Error(`${label}.kind is unsupported`);
  const kind = input.kind as WorkloadKind;
  if (
    typeof input.operation !== "string" ||
    !WORKLOAD_OPERATION_VALUES[kind].includes(input.operation)
  ) {
    throw new Error(`${label}.operation is unsupported for ${kind}`);
  }
  const inputShape = input.inputShape ?? "none";
  if (inputShape !== "none" && inputShape !== "short" && inputShape !== "long") {
    throw new Error(`${label}.inputShape is unsupported`);
  }
  if (input.faults !== undefined && (!Array.isArray(input.faults) || input.faults.length > 16)) {
    throw new Error(`${label}.faults must contain at most 16 descriptors`);
  }
  const scenario: WorkloadScenarioDescriptor = {
    id: input.id,
    kind,
    operation: input.operation,
    iterations: parseBoundedInteger(input.iterations, `${label}.iterations`, 1, 1_000_000, 1),
    concurrency: parseBoundedInteger(input.concurrency, `${label}.concurrency`, 1, 128, 1),
    inputShape,
    faults: (input.faults ?? []).map((fault, faultIndex) =>
      parseFault(fault, `${label}.faults[${faultIndex}]`),
    ),
  };
  if (input.attachmentCount !== undefined)
    scenario.attachmentCount = parseBoundedInteger(
      input.attachmentCount,
      `${label}.attachmentCount`,
      0,
      10_000,
    );
  if (input.attachmentBytes !== undefined)
    scenario.attachmentBytes = parseBoundedInteger(
      input.attachmentBytes,
      `${label}.attachmentBytes`,
      0,
      2 ** 53 - 1,
    );
  if (input.durationMs !== undefined)
    scenario.durationMs = parseBoundedInteger(
      input.durationMs,
      `${label}.durationMs`,
      0,
      86_400_000,
    );
  return scenario;
}

/** Validate and normalize a credential-free benchmark manifest. */
export function parseBenchmarkConfig(input: unknown): BenchmarkConfig {
  if (!isRecord(input)) throw new Error("benchmark config must be an object");
  assertAllowedKeys(
    input,
    ["schemaVersion", "mode", "sampleIntervalMs", "runDurationMs", "scenarios"],
    "benchmark config",
  );
  if (input.schemaVersion !== 1) throw new Error("benchmark config schemaVersion must be 1");
  if (!BENCHMARK_MODES.includes(input.mode as BenchmarkMode))
    throw new Error("benchmark config mode is unsupported");
  if (
    !Array.isArray(input.scenarios) ||
    input.scenarios.length === 0 ||
    input.scenarios.length > 256
  ) {
    throw new Error("benchmark config scenarios must contain 1 to 256 descriptors");
  }
  const scenarios = input.scenarios.map(parseScenario);
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) throw new Error(`duplicate scenario id ${scenario.id}`);
    ids.add(scenario.id);
  }
  const config: BenchmarkConfig = {
    schemaVersion: 1,
    mode: input.mode as BenchmarkMode,
    sampleIntervalMs: parseBoundedInteger(
      input.sampleIntervalMs,
      "sampleIntervalMs",
      100,
      3_600_000,
      1_000,
    ),
    scenarios,
  };
  if (input.runDurationMs !== undefined)
    config.runDurationMs = parseBoundedInteger(
      input.runDurationMs,
      "runDurationMs",
      0,
      7 * 86_400_000,
    );
  return config;
}

function redactText(value: string): string {
  return value
    .replace(/(?:https?:\/\/|file:\/\/)[^\s]+/gi, "<redacted-url>")
    .replace(/(?:\/Users\/|\/home\/|C:\\Users\\)[^\s"']+/gi, "<redacted-path>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<redacted-token>");
}

function redactArtifactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) return "<redacted>";
  if (typeof value === "string") return redactText(value.slice(0, 512));
  if (Array.isArray(value)) return value.map((item) => redactArtifactValue(key, item));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactArtifactValue(childKey, childValue),
      ]),
    );
  }
  return value;
}

/** Redact arbitrary event metadata before it can reach JSONL artifacts. */
export function redactBenchmarkArtifact(value: unknown): unknown {
  return redactArtifactValue("event", value);
}

export function summarizeMetric(values: readonly (number | null | undefined)[]): SummaryMetric {
  const finite = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (finite.length === 0)
    return { count: 0, min: null, max: null, mean: null, median: null, p95: null };
  const middle = Math.floor(finite.length / 2);
  const median = finite.length % 2 ? finite[middle]! : (finite[middle - 1]! + finite[middle]!) / 2;
  const p95 = finite[Math.max(0, Math.ceil(finite.length * 0.95) - 1)]!;
  return {
    count: finite.length,
    min: finite[0]!,
    max: finite[finite.length - 1]!,
    mean: finite.reduce((sum, value) => sum + value, 0) / finite.length,
    median,
    p95,
  };
}

function normalizeReasonCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  return REASON_CODE.test(normalized) ? normalized : "executor_error";
}

export async function emitBenchmarkArtifacts(
  outputDir: string,
  events: readonly unknown[],
  summary: BenchmarkSummary,
): Promise<BenchmarkArtifactPaths> {
  await mkdir(outputDir, { recursive: true });
  const eventsPath = path.join(outputDir, "events.jsonl");
  const summaryPath = path.join(outputDir, "summary.json");
  const jsonl = events
    .map((event) => `${JSON.stringify(redactBenchmarkArtifact(event))}\n`)
    .join("");
  await writeFile(eventsPath, jsonl, "utf8");
  await writeFile(
    summaryPath,
    `${JSON.stringify(redactBenchmarkArtifact(summary), null, 2)}\n`,
    "utf8",
  );
  return { eventsPath, summaryPath };
}

export async function runBenchmark(
  configInput: unknown,
  options: BenchmarkRunOptions,
): Promise<BenchmarkRunResult> {
  const config = parseBenchmarkConfig(configInput);
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const events: unknown[] = [];
  const resourceSamples: BenchmarkResourceSample[] = [];
  const scenarioSummaries: ScenarioRunSummary[] = [];
  let iterationCount = 0;
  let completed = 0;
  let failed = 0;
  let faulted = 0;

  for (const scenario of config.scenarios) {
    const scenarioSummary: ScenarioRunSummary = {
      id: scenario.id,
      kind: scenario.kind,
      iterations: scenario.iterations,
      completed: 0,
      failed: 0,
      faulted: 0,
    };
    type IterationRun = {
      iteration: number;
      result: WorkloadExecutionResult;
      samples: BenchmarkResourceSample[];
      events: readonly unknown[];
    };
    const runs: Array<IterationRun | undefined> = Array.from({ length: scenario.iterations });
    let nextIteration = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const iteration = nextIteration;
        nextIteration += 1;
        if (iteration >= scenario.iterations) return;
        const context: WorkloadExecutionContext = { mode: config.mode, scenario, iteration };
        const localEvents: unknown[] = [
          {
            type: "scenario_start",
            scenarioId: scenario.id,
            kind: scenario.kind,
            operation: scenario.operation,
            iteration,
          },
        ];
        const samples: BenchmarkResourceSample[] = [];
        const before = await options.sampleResource?.(context);
        if (before) {
          samples.push(before);
          localEvents.push({
            type: "resource_sample",
            scenarioId: scenario.id,
            kind: scenario.kind,
            iteration,
            sample: before,
          });
        }
        let result: WorkloadExecutionResult;
        try {
          result = await options.executeScenario(scenario, context);
          if (!result || !["completed", "failed", "faulted"].includes(result.status))
            throw new Error("invalid executor status");
        } catch (error) {
          result = {
            status: "failed",
            reasonCode: error instanceof Error ? error.name : "executor_error",
          };
        }
        localEvents.push({
          type: "scenario_result",
          scenarioId: scenario.id,
          kind: scenario.kind,
          iteration,
          status: result.status,
          reasonCode: normalizeReasonCode(result.reasonCode),
        });
        const after = await options.sampleResource?.(context);
        if (after) {
          samples.push(after);
          localEvents.push({
            type: "resource_sample",
            scenarioId: scenario.id,
            kind: scenario.kind,
            iteration,
            sample: after,
          });
        }
        runs[iteration] = { iteration, result, samples, events: localEvents };
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(scenario.concurrency, scenario.iterations) }, () => worker()),
    );
    for (const run of runs) {
      if (!run) throw new Error(`benchmark iteration ${scenario.id} did not complete`);
      iterationCount += 1;
      events.push(...run.events);
      resourceSamples.push(...run.samples);
      if (run.result.status === "completed") {
        completed += 1;
        scenarioSummary.completed += 1;
      } else if (run.result.status === "faulted") {
        faulted += 1;
        scenarioSummary.faulted += 1;
      } else {
        failed += 1;
        scenarioSummary.failed += 1;
      }
    }
    scenarioSummaries.push(scenarioSummary);
  }

  const endedAt = now().toISOString();
  const values = (key: keyof BenchmarkResourceSample): (number | null | undefined)[] =>
    resourceSamples.map((sample) => sample[key] as number | null | undefined);
  const summary: BenchmarkSummary = {
    schemaVersion: 1,
    mode: config.mode,
    startedAt,
    endedAt,
    scenarioCount: config.scenarios.length,
    iterationCount,
    completed,
    failed,
    faulted,
    resources: {
      targetCount: summarizeMetric(values("targetCount")),
      processCount: summarizeMetric(values("processCount")),
      rssBytes: summarizeMetric(values("rssBytes")),
      workingSetBytes: summarizeMetric(values("workingSetBytes")),
      cpuPercent: summarizeMetric(values("cpuPercent")),
      cpuTimeMs: summarizeMetric(values("cpuTimeMs")),
    },
    scenarios: scenarioSummaries,
  };
  const artifacts = options.outputDir
    ? await emitBenchmarkArtifacts(options.outputDir, events, summary)
    : undefined;
  return artifacts ? { summary, artifacts } : { summary };
}
