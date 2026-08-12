import type { OracleJobPollState } from "./types.js";

export type AdaptiveThinkingClass =
  | "short"
  | "light"
  | "standard"
  | "long"
  | "extended"
  | "heavy"
  | (string & {});

export interface AdaptivePollObservation {
  state?: string;
  progress?: boolean;
  progressAt?: number | string | Date;
  retryAfterMs?: number | null;
  thinkingClass?: AdaptiveThinkingClass;
  terminal?: boolean;
  cancelled?: boolean;
}

export interface AdaptivePollState extends OracleJobPollState {
  /** Poll plan state is intentionally open: providers add states over time. */
  state: string;
  thinkingClass?: AdaptiveThinkingClass;
}

export interface AdaptivePollPlanInput {
  now?: number | string | Date;
  state?: Partial<AdaptivePollState> | string;
  observation?: AdaptivePollObservation;
  remoteState?: string;
  progress?: boolean;
  progressAt?: number | string | Date;
  retryAfterMs?: number | null;
  observedRetryAfterMs?: number | null;
  thinkingClass?: AdaptiveThinkingClass;
  terminal?: boolean;
  cancelled?: boolean;
  minDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  jitterRatio?: number;
  jitterMs?: number;
  /** Stable seed for deterministic jitter. */
  jitterSeed?: number | string;
  seed?: number | string;
  /** Tests and embedders may provide a deterministic unit-jitter source. */
  jitter?: ((seed: string, attempt: number) => number) | false;
}

export interface AdaptivePollPlan {
  state: AdaptivePollState;
  dueAt?: string;
  delayMs?: number;
  /** Alias useful to callers that name the value after the schedule. */
  nextDelayMs?: number;
  baseDelayMs?: number;
  backoffDelayMs?: number;
  jitterMs?: number;
  terminal: boolean;
  cancelled: boolean;
}

export const ADAPTIVE_POLL_DEFAULTS = Object.freeze({
  minDelayMs: 5_000,
  maxDelayMs: 5 * 60_000,
  backoffFactor: 2,
  jitterRatio: 0.1,
});

const TERMINAL_STATES = new Set([
  "completed",
  "complete",
  "done",
  "succeeded",
  "success",
  "failed",
  "failure",
  "cancelled",
  "canceled",
  "unknown",
  "conflict",
  "requires_action",
  "terminal",
]);

/**
 * Compute one durable, bounded nonresident poll schedule.
 *
 * The function is pure. It never reads a clock or random source implicitly when
 * callers provide `now` and `jitterSeed`, which keeps daemon recovery tests and
 * persisted schedules reproducible.
 */
export function computeAdaptivePollPlan(input: AdaptivePollPlanInput = {}): AdaptivePollPlan {
  const nowMs = toMillis(input.now ?? Date.now());
  const observation = input.observation;
  const sourceState =
    typeof input.state === "string" ? { state: input.state } : (input.state ?? {});
  const state: AdaptivePollState = {
    state: normalizeState(
      observation?.state ?? input.remoteState ?? sourceState.state ?? "running",
    ),
    attempts: nonNegativeInt(sourceState.attempts),
    ...(sourceState.dueAt ? { dueAt: sourceState.dueAt } : {}),
    ...(sourceState.lastProgressAt ? { lastProgressAt: sourceState.lastProgressAt } : {}),
    ...(sourceState.retryAfterMs === undefined ? {} : { retryAfterMs: sourceState.retryAfterMs }),
    ...(sourceState.thinkingClass ? { thinkingClass: sourceState.thinkingClass } : {}),
  };

  const thinkingClass = observation?.thinkingClass ?? input.thinkingClass ?? state.thinkingClass;
  if (thinkingClass) state.thinkingClass = thinkingClass;
  const progress = observation?.progress ?? input.progress ?? false;
  if (progress) {
    state.lastProgressAt = toIso(observation?.progressAt ?? input.progressAt ?? nowMs);
  }

  // An observation object represents a fresh read. Its absent retryAfter means
  // that a previous rate-limit delay has been consumed and must not stick forever.
  const hasFreshObservation = observation !== undefined;
  const retryAfterValue = hasFreshObservation
    ? observation?.retryAfterMs
    : (input.retryAfterMs ?? input.observedRetryAfterMs ?? state.retryAfterMs);
  const retryAfterMs = normalizeDelay(retryAfterValue);
  if (retryAfterMs === undefined) delete state.retryAfterMs;
  else state.retryAfterMs = retryAfterMs;

  const terminal = Boolean(
    input.terminal ?? observation?.terminal ?? isTerminalPollState(state.state),
  );
  const cancelled = Boolean(input.cancelled ?? observation?.cancelled);
  state.attempts += 1;

  if (terminal || cancelled) {
    delete state.dueAt;
    return {
      state,
      terminal,
      cancelled,
    };
  }

  const minDelayMs = positiveFinite(input.minDelayMs, ADAPTIVE_POLL_DEFAULTS.minDelayMs);
  const maxDelayMs = Math.max(
    minDelayMs,
    positiveFinite(input.maxDelayMs, ADAPTIVE_POLL_DEFAULTS.maxDelayMs),
  );
  const backoffFactor = Math.max(
    1,
    positiveFinite(input.backoffFactor, ADAPTIVE_POLL_DEFAULTS.backoffFactor),
  );
  const jitterRatio = Math.min(
    0.5,
    Math.max(0, finiteOr(input.jitterRatio, ADAPTIVE_POLL_DEFAULTS.jitterRatio)),
  );
  const multiplier = thinkingMultiplier(thinkingClass);
  const exponent = progress ? 0 : Math.max(0, state.attempts - 1);
  const backoffDelayMs = minDelayMs * multiplier * backoffFactor ** exponent;
  const boundedBase = clamp(backoffDelayMs, minDelayMs, maxDelayMs);
  const seed = String(input.jitterSeed ?? input.seed ?? "oracle-adaptive-poll");
  const unit =
    input.jitter === false
      ? 0
      : input.jitter
        ? clamp(input.jitter(seed, state.attempts), -1, 1)
        : deterministicUnit(seed, state.attempts);
  const requestedJitterMs =
    input.jitterMs === undefined
      ? boundedBase * jitterRatio * unit
      : finiteOr(input.jitterMs, 0) * unit;
  const jitteredDelayMs = clamp(boundedBase + requestedJitterMs, minDelayMs, maxDelayMs);
  // A provider's retry-after is a hard lower bound, including when it exceeds
  // maxDelayMs. Rate-limit lanes must never be retried earlier than requested.
  const delayMs = Math.max(jitteredDelayMs, retryAfterMs ?? 0, 1);
  state.dueAt = toIso(nowMs + delayMs);

  return {
    state,
    dueAt: state.dueAt,
    delayMs,
    nextDelayMs: delayMs,
    baseDelayMs: boundedBase,
    backoffDelayMs,
    jitterMs: requestedJitterMs,
    terminal: false,
    cancelled: false,
  };
}

export interface ScheduledAdaptivePollJob {
  id: string;
  state: AdaptivePollState;
  status?: string;
  input?: unknown;
}

export interface AdaptivePollingLease {
  [key: string]: unknown;
}

export interface AdaptivePollingSchedulerOptions<Lease = AdaptivePollingLease> {
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  loadDuePolls?: () => Promise<readonly ScheduledAdaptivePollJob[]>;
  persistPollState?: (jobId: string, state: AdaptivePollState) => Promise<void> | void;
  acquirePollingLease?: (job: ScheduledAdaptivePollJob) => Promise<Lease>;
  poll?: (
    job: ScheduledAdaptivePollJob,
    lease: Lease,
    signal: AbortSignal,
  ) => Promise<AdaptivePollObservation | void>;
  releasePollingLease?: (lease: Lease, job: ScheduledAdaptivePollJob) => Promise<void> | void;
  onPollError?: (error: unknown, job: ScheduledAdaptivePollJob) => void;
  plan?: Pick<
    AdaptivePollPlanInput,
    "minDelayMs" | "maxDelayMs" | "backoffFactor" | "jitterRatio" | "jitterSeed"
  >;
}

interface TimerRecord {
  timer: unknown;
  job: ScheduledAdaptivePollJob;
}

/**
 * Durable nonresident scheduler. It owns only timers and injected callbacks;
 * browser targets, CDP clients, and coordinator leases remain outside this
 * module. A target/lease therefore exists only for the duration of `poll`.
 */
export class AdaptivePollingScheduler<Lease = AdaptivePollingLease> {
  readonly #options: AdaptivePollingSchedulerOptions<Lease>;
  readonly #timers = new Map<string, TimerRecord>();
  readonly #running = new Map<string, AbortController>();
  readonly #cancelled = new Set<string>();
  #closed = false;

  constructor(options: AdaptivePollingSchedulerOptions<Lease> = {}) {
    this.#options = options;
  }

  get pendingCount(): number {
    return this.#timers.size;
  }

  get activePollCount(): number {
    return this.#running.size;
  }

  /** Restore persisted due times without creating a resident target or lease. */
  async restoreDuePolls(jobs?: readonly ScheduledAdaptivePollJob[]): Promise<number> {
    if (this.#closed) return 0;
    const restored = jobs ?? (await this.#options.loadDuePolls?.()) ?? [];
    let count = 0;
    for (const job of restored) {
      if (!job?.id || !job.state?.dueAt || isTerminalPollState(job.state.state)) continue;
      if (job.status && isTerminalJobStatus(job.status)) continue;
      this.#scheduleTimer(job);
      count += 1;
    }
    return count;
  }

  /** Schedule one due poll, persisting the state before arming its timer. */
  async scheduleNonresidentPoll(
    jobOrId: ScheduledAdaptivePollJob | string,
    state?: AdaptivePollState,
  ): Promise<AdaptivePollState | undefined> {
    if (this.#closed) return undefined;
    const job =
      typeof jobOrId === "string" ? (state ? { id: jobOrId, state } : undefined) : jobOrId;
    if (!job) throw new Error("scheduleNonresidentPoll requires a poll state.");
    this.#cancelled.delete(job.id);
    if (job.status && isTerminalJobStatus(job.status)) {
      await this.#persistStopped(job);
      return job.state;
    }
    if (isTerminalPollState(job.state.state)) {
      await this.#persistStopped(job);
      return job.state;
    }
    await this.#persist(job.id, job.state);
    this.#scheduleTimer(job);
    return job.state;
  }

  /** Cancel before or during a poll; cancellation wins the scheduling race. */
  async cancel(jobId: string): Promise<void> {
    this.#cancelled.add(jobId);
    const timer = this.#timers.get(jobId);
    if (timer) {
      this.#clearTimer(timer.timer);
      this.#timers.delete(jobId);
    }
    this.#running.get(jobId)?.abort();
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const [jobId, timer] of this.#timers) {
      this.#clearTimer(timer.timer);
      this.#cancelled.add(jobId);
    }
    this.#timers.clear();
    for (const controller of this.#running.values()) controller.abort();
  }

  #scheduleTimer(job: ScheduledAdaptivePollJob): void {
    const existing = this.#timers.get(job.id);
    if (existing) this.#clearTimer(existing.timer);
    const dueMs = toMillis(job.state.dueAt ?? Date.now());
    const nowMs = this.#now();
    // Even corrupt/old records get a non-zero turn through the event loop. A
    // planner-produced dueAt is always >= one millisecond, preventing loops.
    const delayMs = Math.max(1, dueMs - nowMs);
    const timer = this.#setTimer(() => {
      this.#timers.delete(job.id);
      void this.#run(job);
    }, delayMs);
    this.#timers.set(job.id, { timer, job });
  }

  async #run(job: ScheduledAdaptivePollJob): Promise<void> {
    if (this.#closed || this.#cancelled.has(job.id) || isTerminalPollState(job.state.state)) return;
    const controller = new AbortController();
    this.#running.set(job.id, controller);
    let lease: Lease | undefined;
    let observation: AdaptivePollObservation = {};
    let pollError: unknown;
    try {
      lease = await this.#acquire(job);
      if (this.#closed || this.#cancelled.has(job.id) || controller.signal.aborted) return;
      observation = (await this.#options.poll?.(job, lease, controller.signal)) ?? {};
    } catch (error) {
      pollError = error;
      this.#options.onPollError?.(error, job);
    } finally {
      try {
        if (lease !== undefined) await this.#options.releasePollingLease?.(lease, job);
      } catch (error) {
        pollError ??= error;
        this.#options.onPollError?.(error, job);
      }
      this.#running.delete(job.id);
    }

    if (this.#closed || this.#cancelled.has(job.id) || controller.signal.aborted) return;
    const next = computeAdaptivePollPlan({
      now: this.#now(),
      state: job.state,
      observation,
      ...(this.#options.plan ?? {}),
    });
    // A transient poll failure still gets a bounded backoff; never retry in a
    // zero-delay loop. Error handling is deliberately outside the lease scope.
    if (pollError && next.terminal) return;
    await this.scheduleNonresidentPoll({ ...job, state: next.state });
  }

  async #acquire(job: ScheduledAdaptivePollJob): Promise<Lease> {
    if (this.#options.acquirePollingLease) return await this.#options.acquirePollingLease(job);
    return {} as Lease;
  }

  async #persist(jobId: string, state: AdaptivePollState): Promise<void> {
    await this.#options.persistPollState?.(jobId, state);
  }

  async #persistStopped(job: ScheduledAdaptivePollJob): Promise<void> {
    const stopped: AdaptivePollState = { ...job.state };
    delete stopped.dueAt;
    await this.#persist(job.id, stopped);
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #setTimer(callback: () => void, delayMs: number): unknown {
    return this.#options.setTimeout?.(callback, delayMs) ?? setTimeout(callback, delayMs);
  }

  #clearTimer(timer: unknown): void {
    if (this.#options.clearTimeout) this.#options.clearTimeout(timer);
    else clearTimeout(timer as ReturnType<typeof setTimeout>);
  }
}

export function isTerminalPollState(state: unknown): boolean {
  return typeof state === "string" && TERMINAL_STATES.has(state.toLowerCase());
}

function isTerminalJobStatus(status: string): boolean {
  return isTerminalPollState(status) || status === "cancel_requested";
}

function normalizeState(state: string | undefined): string {
  return state?.trim() || "running";
}

function thinkingMultiplier(thinkingClass: AdaptiveThinkingClass | undefined): number {
  switch (thinkingClass?.toLowerCase()) {
    case "heavy":
      return 4;
    case "long":
    case "extended":
      return 2.5;
    case "standard":
      return 1.5;
    case "short":
    case "light":
      return 1;
    default:
      return 1;
  }
}

function deterministicUnit(seed: string, attempt: number): number {
  let hash = 2166136261;
  const value = `${seed}:${attempt}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 0xffffffff) * 2 - 1;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

function positiveFinite(value: unknown, fallback: number): number {
  return Math.max(1, finiteOr(value, fallback));
}

function normalizeDelay(value: unknown): number | undefined {
  return isFiniteNumber(value) && value >= 0 ? Math.ceil(value) : undefined;
}

function nonNegativeInt(value: unknown): number {
  return isFiniteNumber(value) ? Math.max(0, Math.floor(value)) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toMillis(value: number | string | Date): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : Date.now();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function toIso(value: number | string | Date): string {
  return new Date(toMillis(value)).toISOString();
}
