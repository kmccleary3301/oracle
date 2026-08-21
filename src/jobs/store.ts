import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getOracleHomeDir } from "../oracleHome.js";
import type { AdaptivePollState } from "./adaptivePolling.js";
import type {
  OracleJobActionRequired,
  OracleJobCreateInput,
  OracleJobError,
  OracleJobEvent,
  OracleJobEventInput,
  OracleJobOutcome,
  OracleJobOwnerLease,
  OracleJobPhase,
  OracleJobRecord,
  OracleJobResultResponse,
  OracleJobStatus,
  OracleJobSubmissionState,
  OracleJobTransitionInput,
} from "./types.js";

export interface OracleJobStoreOptions {
  rootDir?: string;
  maxQueuedJobs?: number;
  maxQueuedPersistedInputBytes?: number;
  /** Alias retained for callers that use the shorter input-budget name. */
  maxQueuedInputBytes?: number;
  maxPrincipalQueuedJobs?: number;
  maxPrincipalQueuedInputBytes?: number;
  maxPrincipalAdmissionsPerWindow?: number;
  principalRateWindowMs?: number;
}
export interface OracleJobUpdateGuard {
  expectedStatus?: OracleJobStatus;
  expectedGeneration?: number;
  expectedOwnerLeaseId?: string | null;
}
export interface OracleJobOwnerLeaseInput {
  generation: number;
  leaseId?: string;
  role?: OracleJobOwnerLease["role"];
  ownerPid?: number;
  expiresAt?: string;
  expectedGeneration?: number;
  expectedOwnerLeaseId?: string | null;
}

export type OracleJobAdmissionReason =
  | "queued_jobs_exhausted"
  | "queued_input_bytes_exhausted"
  | "principal_queued_jobs_exhausted"
  | "principal_queued_input_bytes_exhausted"
  | "principal_rate_limited"
  | "input_bytes_exceeded";

export class OracleJobAdmissionError extends Error {
  readonly statusCode: 429 | 503;
  readonly reason: OracleJobAdmissionReason | "admission_unavailable";
  readonly retryAfterSeconds: number;

  constructor(
    reason: OracleJobAdmissionReason | "admission_unavailable",
    message: string,
    retryAfterSeconds = 1,
    statusCode: 429 | 503 = 429,
  ) {
    super(message);
    this.name = "OracleJobAdmissionError";
    this.reason = reason;
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
    this.statusCode = statusCode;
  }
}

export class OracleJobIdempotencyConflictError extends Error {
  readonly existingJobId: string;

  constructor(existingJobId: string) {
    super(`Idempotency key already belongs to job ${existingJobId} with a different request.`);
    this.name = "OracleJobIdempotencyConflictError";
    this.existingJobId = existingJobId;
  }
}
export interface OracleJobAdmission {
  job: OracleJobRecord;
  created: boolean;
}

interface AdmissionReservation {
  jobId: string;
  created: boolean;
}

const ADMISSION_PENDING_FILE = ".admission-pending.json";
const IDEMPOTENCY_DB_FILE = ".idempotency.sqlite";
const ADMISSION_PENDING_TTL_MS = 60_000;
const DEFAULT_MAX_QUEUED_JOBS = 256;
const DEFAULT_MAX_QUEUED_INPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_PRINCIPAL_QUEUED_JOBS = 128;
const DEFAULT_MAX_PRINCIPAL_QUEUED_INPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_PRINCIPAL_ADMISSIONS_PER_WINDOW = 128;
const DEFAULT_PRINCIPAL_RATE_WINDOW_MS = 60_000;
const IDEMPOTENCY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS job_idempotency (
    idempotency_key TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    request_hash TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS job_idempotency_job_id
    ON job_idempotency(job_id);
  CREATE TABLE IF NOT EXISTS job_admissions (
    job_id TEXT PRIMARY KEY,
    idempotency_key TEXT UNIQUE,
    request_hash TEXT NOT NULL,
    principal_hash TEXT NOT NULL,
    input_bytes INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'terminal')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS job_admissions_active
    ON job_admissions(status);
  CREATE INDEX IF NOT EXISTS job_admissions_principal
    ON job_admissions(principal_hash, status);
  CREATE TABLE IF NOT EXISTS principal_admissions (
    principal_hash TEXT NOT NULL,
    admitted_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS principal_admissions_window
    ON principal_admissions(principal_hash, admitted_at);
`;
export class OracleJobStore {
  readonly rootDir: string;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly maxQueuedJobs: number;
  private readonly maxQueuedInputBytes: number;
  private readonly maxPrincipalQueuedJobs: number;
  private readonly maxPrincipalQueuedInputBytes: number;
  private readonly maxPrincipalAdmissionsPerWindow: number;
  private readonly principalRateWindowMs: number;

  constructor(options: OracleJobStoreOptions = {}) {
    this.rootDir = path.resolve(options.rootDir ?? defaultJobRootDir());
    this.maxQueuedJobs = Math.max(0, Math.floor(options.maxQueuedJobs ?? DEFAULT_MAX_QUEUED_JOBS));
    this.maxQueuedInputBytes = Math.max(
      0,
      Math.floor(
        options.maxQueuedPersistedInputBytes ??
          options.maxQueuedInputBytes ??
          DEFAULT_MAX_QUEUED_INPUT_BYTES,
      ),
    );
    this.maxPrincipalQueuedJobs = Math.max(
      0,
      Math.floor(options.maxPrincipalQueuedJobs ?? DEFAULT_MAX_PRINCIPAL_QUEUED_JOBS),
    );
    this.maxPrincipalQueuedInputBytes = Math.max(
      0,
      Math.floor(options.maxPrincipalQueuedInputBytes ?? DEFAULT_MAX_PRINCIPAL_QUEUED_INPUT_BYTES),
    );
    this.maxPrincipalAdmissionsPerWindow = Math.max(
      0,
      Math.floor(
        options.maxPrincipalAdmissionsPerWindow ?? DEFAULT_MAX_PRINCIPAL_ADMISSIONS_PER_WINDOW,
      ),
    );
    this.principalRateWindowMs = Math.max(
      1,
      Math.floor(options.principalRateWindowMs ?? DEFAULT_PRINCIPAL_RATE_WINDOW_MS),
    );
  }

  async createJob(input: OracleJobCreateInput): Promise<OracleJobRecord> {
    return (await this.admitJob(input)).job;
  }

  /**
   * Admission is reserved in SQLite before any job directory is created. The
   * returned `created` bit is the only authority a daemon may use to enqueue:
   * an idempotency loser attaches to the durable winner and never runs a handler.
   */
  async admitJob(input: OracleJobCreateInput): Promise<OracleJobAdmission> {
    const inputValue = input.input ?? {};
    const persistedInput = serializePersistedJson(inputValue);
    const inputBytes = Buffer.byteLength(persistedInput, "utf8");
    const principalHash = input.principalHash ?? "anonymous";
    await fs.mkdir(this.rootDir, { recursive: true });
    await this.reconcileAdmissionLedger();
    const reservation = this.reserveAdmission({
      input,
      principalHash,
      inputBytes,
      jobId: createSortableJobId(),
      requestHash: requestHashForInput(input),
    });
    if (!reservation.created) {
      const existing = await this.waitForJob(reservation.jobId);
      if (!existing) {
        throw new OracleJobAdmissionError(
          "admission_unavailable",
          "The durable winner has not materialized; retry the request.",
          1,
          503,
        );
      }
      await this.assertIdempotencyPayload(existing, input);
      return { job: existing, created: false };
    }
    try {
      const job = await this.createJobFiles(
        input,
        reservation.jobId,
        persistedInput,
        inputBytes,
        principalHash,
      );
      this.markAdmissionMaterialized(job.id);
      return { job, created: true };
    } catch (error) {
      this.abandonAdmission(reservation.jobId, input.idempotencyKey);
      throw error;
    }
  }

  private async createJobFiles(
    input: OracleJobCreateInput,
    id: string,
    persistedInput: string,
    inputBytes: number,
    principalHash: string,
  ): Promise<OracleJobRecord> {
    const now = new Date().toISOString();
    const jobDir = this.jobDir(id);
    await fs.mkdir(jobDir, { recursive: true });
    const inputPath = path.join(jobDir, "input.json");
    const eventLogPath = path.join(jobDir, "events.ndjson");
    const generation = input.generation ?? 0;
    const job: OracleJobRecord = {
      id,
      kind: input.kind,
      status: "queued",
      phase: "accepted",
      createdAt: now,
      updatedAt: now,
      inputSummary: input.inputSummary ?? summarizeJobInput(input.input),
      inputBytes,
      principalHash,
      inputPath,
      eventLogPath,
      attempt: input.attempt ?? 0,
      generation,
      ...(input.ownerGeneration === undefined ? {} : { ownerGeneration: input.ownerGeneration }),
      ...(input.ownerLeaseId === undefined ? {} : { ownerLeaseId: input.ownerLeaseId }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      requestHash: requestHashForInput(input),
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      ...(input.expectedHead === undefined ? {} : { expectedHead: input.expectedHead }),
      submissionState: input.submissionState ?? "pre_submit",
    };
    try {
      await atomicWriteText(inputPath, persistedInput);
      await fs
        .writeFile(eventLogPath, "", { flag: "wx" })
        .catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      await this.writeJob(job);
      await this.appendEvent(id, "info", "accepted", `Accepted ${input.kind} job.`, undefined, {
        reasonCode: "accepted",
      });
      return await this.requireJob(id);
    } catch (error) {
      await fs.rm(jobDir, { recursive: true, force: true });
      throw error;
    }
  }

  async readJob(id: string): Promise<OracleJobRecord | null> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.jobPath(id), "utf8"),
      ) as Partial<OracleJobRecord>;
      return {
        ...parsed,
        id: parsed.id ?? id,
        inputBytes: parsed.inputBytes ?? 0,
        attempt: parsed.attempt ?? 0,
        generation: parsed.generation ?? 0,
      } as OracleJobRecord;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw error;
    }
  }

  async readInput(id: string): Promise<unknown> {
    const job = await this.requireJob(id);
    return JSON.parse(await fs.readFile(job.inputPath, "utf8")) as unknown;
  }

  async updateJob(id: string, patch: Partial<OracleJobRecord>): Promise<OracleJobRecord> {
    return await this.withLock(id, async () => await this.updateJobUnlocked(id, patch));
  }

  async updateJobIfCurrent(
    id: string,
    patch: Partial<OracleJobRecord>,
    guard: OracleJobUpdateGuard,
  ): Promise<OracleJobRecord | null> {
    return await this.withLock(id, async () => {
      const current = await this.requireJob(id);
      if (
        (guard.expectedStatus !== undefined && current.status !== guard.expectedStatus) ||
        (guard.expectedGeneration !== undefined &&
          current.generation !== guard.expectedGeneration) ||
        (guard.expectedOwnerLeaseId !== undefined &&
          (current.ownerLeaseId ?? null) !== guard.expectedOwnerLeaseId)
      ) {
        return null;
      }
      return await this.updateJobUnlocked(id, patch);
    });
  }

  async updatePollState(
    id: string,
    poll: AdaptivePollState,
    guard: OracleJobUpdateGuard = {},
  ): Promise<OracleJobRecord | null> {
    return await this.withLock(id, async () => {
      const current = await this.requireJob(id);
      if (
        (guard.expectedStatus !== undefined && current.status !== guard.expectedStatus) ||
        (guard.expectedGeneration !== undefined &&
          current.generation !== guard.expectedGeneration) ||
        (guard.expectedOwnerLeaseId !== undefined &&
          (current.ownerLeaseId ?? null) !== guard.expectedOwnerLeaseId)
      ) {
        return null;
      }
      return await this.updateJobUnlocked(id, {
        runtime: {
          ...(current.runtime ?? {}),
          poll: { ...poll },
        },
      });
    });
  }

  async clearPollState(
    id: string,
    guard: OracleJobUpdateGuard = {},
  ): Promise<OracleJobRecord | null> {
    return await this.withLock(id, async () => {
      const current = await this.requireJob(id);
      if (
        (guard.expectedStatus !== undefined && current.status !== guard.expectedStatus) ||
        (guard.expectedGeneration !== undefined &&
          current.generation !== guard.expectedGeneration) ||
        (guard.expectedOwnerLeaseId !== undefined &&
          (current.ownerLeaseId ?? null) !== guard.expectedOwnerLeaseId)
      ) {
        return null;
      }
      const runtime = { ...(current.runtime ?? {}) };
      delete runtime.poll;
      return await this.updateJobUnlocked(id, { runtime });
    });
  }

  async transitionJob(
    id: string,
    status: OracleJobStatus,
    phase: OracleJobPhase,
    message?: string,
    options?: Omit<OracleJobTransitionInput, "id" | "expectedStatus" | "nextStatus" | "phase">,
  ): Promise<OracleJobRecord>;
  async transitionJob(input: OracleJobTransitionInput): Promise<OracleJobRecord | null>;
  async transitionJob(
    idOrInput: string | OracleJobTransitionInput,
    status?: OracleJobStatus,
    phase?: OracleJobPhase,
    message?: string,
    legacyOptions?: Omit<
      OracleJobTransitionInput,
      "id" | "expectedStatus" | "nextStatus" | "phase"
    >,
  ): Promise<OracleJobRecord | null> {
    const input: OracleJobTransitionInput =
      typeof idOrInput === "string"
        ? {
            id: idOrInput,
            expectedStatus: undefined as unknown as OracleJobStatus,
            nextStatus: status as OracleJobStatus,
            phase: phase as OracleJobPhase,
            message,
            ...legacyOptions,
          }
        : idOrInput;
    const legacy = typeof idOrInput === "string";
    const result = await this.withLock(input.id, async () => {
      const current = await this.requireJob(input.id);
      if (
        !legacy &&
        (current.status !== input.expectedStatus ||
          (input.expectedPhase !== undefined && current.phase !== input.expectedPhase) ||
          (input.expectedGeneration !== undefined &&
            current.generation !== input.expectedGeneration) ||
          (input.expectedOwnerGeneration !== undefined &&
            (current.ownerGeneration ?? null) !== input.expectedOwnerGeneration) ||
          (input.expectedOwnerLeaseId !== undefined &&
            (current.ownerLeaseId ?? null) !== input.expectedOwnerLeaseId))
      ) {
        return null;
      }
      const now = new Date().toISOString();
      const terminal = isTerminalStatus(input.nextStatus) || input.outcome !== undefined;
      const outcome = input.outcome ?? outcomeForStatus(input.nextStatus);
      const next = await this.updateJobUnlocked(input.id, {
        status: input.nextStatus,
        phase: input.phase,
        ...(input.nextStatus === "running"
          ? { startedAt: current.startedAt ?? now, attempt: current.attempt + 1 }
          : {}),
        ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
        ...(input.generation === undefined ? {} : { generation: input.generation }),
        ...(input.ownerGeneration === undefined
          ? {}
          : { ownerGeneration: input.ownerGeneration ?? undefined }),
        ...(input.ownerLeaseId === undefined
          ? {}
          : { ownerLeaseId: input.ownerLeaseId ?? undefined }),
        ...(terminal ? { completedAt: current.completedAt ?? now, outcome } : {}),
        ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
        ...(input.actionRequired === undefined ? {} : { actionRequired: input.actionRequired }),
        ...(input.error === undefined ? {} : { error: input.error }),
        ...(input.evidencePath === undefined ? {} : { evidencePath: input.evidencePath }),
        ...(terminal ? { ownerLeaseId: undefined, ownerGeneration: undefined } : {}),
        ...(terminal && current.runtime?.poll
          ? {
              runtime: {
                ...(current.runtime ?? {}),
                poll: { ...current.runtime.poll, dueAt: undefined },
              },
            }
          : {}),
      });
      const event = await this.appendEventUnlocked(input.id, {
        id: input.id,
        level:
          input.nextStatus === "failed" ||
          input.nextStatus === "unknown" ||
          input.nextStatus === "conflict" ||
          input.nextStatus === "requires_action"
            ? "error"
            : input.nextStatus === "cancel_requested" || input.nextStatus === "cancelled"
              ? "warn"
              : "info",
        phase: input.phase,
        message: input.message ?? input.nextStatus,
        reasonCode: input.reasonCode,
        outcome,
      });
      return event ? next : next;
    });
    if (result === null && !legacy) return null;
    if (result === null) throw new Error(`Oracle job ${input.id} was not found.`);
    return result;
  }

  async compareAndSetJob(input: OracleJobTransitionInput): Promise<OracleJobRecord | null> {
    return await this.transitionJob(input);
  }

  async casTransitionJob(input: OracleJobTransitionInput): Promise<OracleJobRecord | null> {
    return await this.transitionJob(input);
  }

  async appendEvent(
    id: string,
    level: OracleJobEvent["level"],
    phase: OracleJobPhase,
    message: string,
    data?: unknown,
    options?: Pick<OracleJobEventInput, "timestamp" | "reasonCode" | "outcome">,
  ): Promise<OracleJobEvent>;
  async appendEvent(input: OracleJobEventInput): Promise<OracleJobEvent>;
  async appendEvent(
    idOrInput: string | OracleJobEventInput,
    level?: OracleJobEvent["level"],
    phase?: OracleJobPhase,
    message?: string,
    data?: unknown,
    options?: Pick<OracleJobEventInput, "timestamp" | "reasonCode" | "outcome">,
  ): Promise<OracleJobEvent> {
    const input: OracleJobEventInput =
      typeof idOrInput === "string"
        ? {
            id: idOrInput,
            level: level as OracleJobEvent["level"],
            phase: phase as OracleJobPhase,
            message: message as string,
            data,
            ...options,
          }
        : idOrInput;
    return await this.withLock(
      input.id,
      async () => await this.appendEventUnlocked(input.id, input),
    );
  }

  async readEvents(id: string, afterSeq = 0): Promise<OracleJobEvent[]> {
    const job = await this.requireJob(id);
    const raw = await fs
      .readFile(job.eventLogPath, "utf8")
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as OracleJobEvent)
      .filter((event) => event.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq);
  }

  async writeResult(id: string, result: unknown): Promise<OracleJobRecord> {
    return await this.withLock(id, async () => {
      const resultPath = path.join(this.jobDir(id), "result.json");
      await atomicWriteJson(resultPath, result);
      return await this.updateJobUnlocked(id, {
        resultPath,
        resultSummary: summarizeResult(result),
      });
    });
  }

  async readResult(id: string): Promise<OracleJobResultResponse> {
    const job = await this.readJob(id);
    if (!job) return { found: false, ready: false };
    if (!job.resultPath) return { found: true, ready: false, job };
    try {
      const result = JSON.parse(await fs.readFile(job.resultPath, "utf8")) as unknown;
      return { found: true, ready: true, job, result };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { found: true, ready: false, job };
      throw error;
    }
  }

  async listJobs(limit = 20): Promise<OracleJobRecord[]> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const jobs: OracleJobRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("job_")) continue;
      try {
        await fs.access(path.join(this.jobDir(entry.name), ADMISSION_PENDING_FILE));
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        const job = await this.readJob(entry.name);
        if (job) jobs.push(job);
      } catch {
        // Corrupt job records should not make listing unusable.
      }
    }
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.max(1, limit));
  }

  async getJobByIdempotencyKey(idempotencyKey: string): Promise<OracleJobRecord | null> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const indexed = this.readIdempotencyIndex(idempotencyKey);
    if (indexed) {
      const job = await this.readJob(indexed.jobId);
      if (job) {
        try {
          await fs.rm(path.join(this.jobDir(job.id), ADMISSION_PENDING_FILE), { force: true });
        } catch {
          // The index is authoritative once the candidate record exists.
        }
        return job;
      }
      this.removeIndexedIdempotencyKey(idempotencyKey, indexed.jobId);
    }

    // Backfill records written before the durable index existed. Sorting makes
    // a pre-existing duplicate resolve to the same deterministic winner.
    const jobs = (await this.listJobs(Number.MAX_SAFE_INTEGER))
      .filter((job) => job.idempotencyKey === idempotencyKey)
      .sort((a, b) => a.id.localeCompare(b.id));
    const legacy = jobs[0];
    if (!legacy) return null;
    const legacyInput = await this.readInput(legacy.id);
    const effectiveHash = legacy.requestHash ?? requestHashForRecord(legacy, legacyInput);
    this.insertLegacyIdempotencyKey(idempotencyKey, legacy.id, effectiveHash);
    const winner = this.readIdempotencyIndex(idempotencyKey);
    if (!winner) return legacy;
    return (await this.readJob(winner.jobId)) ?? legacy;
  }
  private async reconcileAdmissionLedger(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const materialized: Array<{
      job: OracleJobRecord;
      inputBytes: number;
      requestHash: string;
    }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("job_")) continue;
      const job = await this.readJob(entry.name).catch(() => null);
      if (!job) continue;
      let inputBytes = job.inputBytes;
      if (!Number.isSafeInteger(inputBytes) || inputBytes < 0) {
        inputBytes = await fs
          .stat(job.inputPath)
          .then((stat) => stat.size)
          .catch(() => 0);
      }
      const input = await fs
        .readFile(job.inputPath, "utf8")
        .then((value) => JSON.parse(value) as unknown)
        .catch(() => undefined);
      materialized.push({
        job,
        inputBytes,
        requestHash: job.requestHash ?? requestHashForRecord(job, input),
      });
    }
    this.withAdmissionDatabase((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const now = Date.now();
        for (const { job, inputBytes, requestHash } of materialized) {
          db.prepare(
            `INSERT INTO job_admissions
              (job_id, idempotency_key, request_hash, principal_hash, input_bytes, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(job_id) DO UPDATE SET
               status = excluded.status,
               input_bytes = excluded.input_bytes,
               principal_hash = excluded.principal_hash,
               updated_at = excluded.updated_at`,
          ).run(
            job.id,
            job.idempotencyKey ?? null,
            requestHash,
            job.principalHash ?? "anonymous",
            inputBytes,
            isTerminalStatus(job.status) ? "terminal" : "active",
            Date.parse(job.createdAt) || now,
            now,
          );
          if (job.idempotencyKey) {
            db.prepare(
              `INSERT INTO job_idempotency (idempotency_key, job_id, request_hash)
               VALUES (?, ?, ?)
               ON CONFLICT(idempotency_key) DO NOTHING`,
            ).run(job.idempotencyKey, job.id, requestHash);
          }
        }
        const pending = db
          .prepare(
            "SELECT job_id AS jobId, idempotency_key AS idempotencyKey, updated_at AS updatedAt FROM job_admissions WHERE status = 'pending'",
          )
          .all() as Array<{ jobId?: unknown; idempotencyKey?: unknown; updatedAt?: unknown }>;
        const existingIds = new Set(materialized.map(({ job }) => job.id));
        for (const row of pending) {
          if (
            typeof row.jobId !== "string" ||
            existingIds.has(row.jobId) ||
            typeof row.updatedAt !== "number" ||
            now - row.updatedAt < ADMISSION_PENDING_TTL_MS
          ) {
            continue;
          }
          db.prepare("DELETE FROM job_admissions WHERE job_id = ? AND status = 'pending'").run(
            row.jobId,
          );
          if (typeof row.idempotencyKey === "string") {
            db.prepare("DELETE FROM job_idempotency WHERE idempotency_key = ? AND job_id = ?").run(
              row.idempotencyKey,
              row.jobId,
            );
          }
        }
        db.prepare("DELETE FROM principal_admissions WHERE admitted_at < ?").run(
          now - this.principalRateWindowMs,
        );
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the original database error.
        }
        throw error;
      }
    });
  }

  private reserveAdmission(input: {
    input: OracleJobCreateInput;
    principalHash: string;
    inputBytes: number;
    jobId: string;
    requestHash: string;
  }): AdmissionReservation {
    try {
      return this.withAdmissionDatabase((db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const now = Date.now();
          db.prepare("DELETE FROM principal_admissions WHERE admitted_at < ?").run(
            now - this.principalRateWindowMs,
          );
          if (input.input.idempotencyKey) {
            const existing = db
              .prepare(
                `SELECT job_id AS jobId, request_hash AS requestHash
                 FROM job_admissions WHERE idempotency_key = ?`,
              )
              .get(input.input.idempotencyKey) as
              | { jobId?: unknown; requestHash?: unknown }
              | undefined;
            if (typeof existing?.jobId === "string") {
              if (existing.requestHash !== input.requestHash) {
                throw new OracleJobIdempotencyConflictError(existing.jobId);
              }
              db.exec("COMMIT");
              return { jobId: existing.jobId, created: false };
            }
            const legacy = db
              .prepare(
                `SELECT job_id AS jobId, request_hash AS requestHash
                 FROM job_idempotency WHERE idempotency_key = ?`,
              )
              .get(input.input.idempotencyKey) as
              | { jobId?: unknown; requestHash?: unknown }
              | undefined;
            if (typeof legacy?.jobId === "string") {
              if (legacy.requestHash !== input.requestHash) {
                throw new OracleJobIdempotencyConflictError(legacy.jobId);
              }
              db.exec("COMMIT");
              return { jobId: legacy.jobId, created: false };
            }
          }
          const queued = db
            .prepare(
              `SELECT COUNT(*) AS count, COALESCE(SUM(input_bytes), 0) AS bytes
               FROM job_admissions
               WHERE status IN ('pending', 'active')`,
            )
            .get() as { count?: number; bytes?: number };
          if ((queued.count ?? 0) >= this.maxQueuedJobs) {
            throw new OracleJobAdmissionError(
              "queued_jobs_exhausted",
              "The daemon queued-job capacity is exhausted; retry after capacity is released.",
            );
          }
          if ((queued.bytes ?? 0) + input.inputBytes > this.maxQueuedInputBytes) {
            throw new OracleJobAdmissionError(
              "queued_input_bytes_exhausted",
              "The daemon persisted-input capacity is exhausted; retry after active jobs finish.",
            );
          }
          if (input.inputBytes > this.maxQueuedInputBytes) {
            throw new OracleJobAdmissionError(
              "input_bytes_exceeded",
              "The persisted input exceeds the daemon input-byte limit.",
              Math.ceil(this.principalRateWindowMs / 1000),
            );
          }
          const principal = db
            .prepare(
              `SELECT COUNT(*) AS count, COALESCE(SUM(input_bytes), 0) AS bytes
               FROM job_admissions
               WHERE principal_hash = ? AND status IN ('pending', 'active')`,
            )
            .get(input.principalHash) as { count?: number; bytes?: number };
          if ((principal.count ?? 0) >= this.maxPrincipalQueuedJobs) {
            throw new OracleJobAdmissionError(
              "principal_queued_jobs_exhausted",
              "This authenticated principal has reached its queued-job limit.",
            );
          }
          if ((principal.bytes ?? 0) + input.inputBytes > this.maxPrincipalQueuedInputBytes) {
            throw new OracleJobAdmissionError(
              "principal_queued_input_bytes_exhausted",
              "This authenticated principal has reached its persisted-input limit.",
            );
          }
          const rate = db
            .prepare(
              "SELECT COUNT(*) AS count FROM principal_admissions WHERE principal_hash = ? AND admitted_at >= ?",
            )
            .get(input.principalHash, now - this.principalRateWindowMs) as { count?: number };
          if ((rate.count ?? 0) >= this.maxPrincipalAdmissionsPerWindow) {
            throw new OracleJobAdmissionError(
              "principal_rate_limited",
              "This authenticated principal is submitting too quickly; retry after the rate window.",
              Math.ceil(this.principalRateWindowMs / 1000),
            );
          }
          db.prepare(
            `INSERT INTO job_admissions
              (job_id, idempotency_key, request_hash, principal_hash, input_bytes, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
          ).run(
            input.jobId,
            input.input.idempotencyKey ?? null,
            input.requestHash,
            input.principalHash,
            input.inputBytes,
            now,
            now,
          );
          if (input.input.idempotencyKey) {
            db.prepare(
              `INSERT INTO job_idempotency (idempotency_key, job_id, request_hash)
               VALUES (?, ?, ?)`,
            ).run(input.input.idempotencyKey, input.jobId, input.requestHash);
          }
          db.prepare(
            "INSERT INTO principal_admissions (principal_hash, admitted_at) VALUES (?, ?)",
          ).run(input.principalHash, now);
          db.exec("COMMIT");
          return { jobId: input.jobId, created: true };
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Preserve the original admission error.
          }
          throw error;
        }
      });
    } catch (error) {
      if (
        error instanceof OracleJobAdmissionError ||
        error instanceof OracleJobIdempotencyConflictError
      ) {
        throw error;
      }
      throw new OracleJobAdmissionError(
        "admission_unavailable",
        "The daemon admission ledger is temporarily unavailable; retry the request.",
        1,
        503,
      );
    }
  }

  private async waitForJob(id: string): Promise<OracleJobRecord | null> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const job = await this.readJob(id);
      if (job) return job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return await this.readJob(id);
  }

  private markAdmissionMaterialized(jobId: string): void {
    this.withAdmissionDatabase((db) => {
      db.prepare(
        "UPDATE job_admissions SET status = 'active', updated_at = ? WHERE job_id = ?",
      ).run(Date.now(), jobId);
    });
  }

  private abandonAdmission(jobId: string, idempotencyKey?: string): void {
    try {
      this.withAdmissionDatabase((db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("DELETE FROM job_admissions WHERE job_id = ? AND status = 'pending'").run(
            jobId,
          );
          if (idempotencyKey) {
            db.prepare("DELETE FROM job_idempotency WHERE idempotency_key = ? AND job_id = ?").run(
              idempotencyKey,
              jobId,
            );
          }
          db.exec("COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Preserve the original cleanup failure.
          }
          throw error;
        }
      });
    } catch {
      // A later reconciliation pass removes stale pending reservations.
    }
  }

  private withAdmissionDatabase<T>(callback: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(path.join(this.rootDir, IDEMPOTENCY_DB_FILE), {
      timeout: 10_000,
    });
    try {
      db.exec(IDEMPOTENCY_SCHEMA);
      return callback(db);
    } finally {
      db.close();
    }
  }

  async markSubmission(
    id: string,
    state: OracleJobSubmissionState,
    metadata: {
      conversationId?: string;
      expectedHead?: string;
      reasonCode?: string;
      evidencePath?: string;
      expectedGeneration?: number;
      expectedOwnerLeaseId?: string | null;
    } = {},
  ): Promise<OracleJobRecord> {
    return await this.withLock(id, async () => {
      const current = await this.requireJob(id);
      if (
        (metadata.expectedGeneration !== undefined &&
          current.generation !== metadata.expectedGeneration) ||
        (metadata.expectedOwnerLeaseId !== undefined &&
          (current.ownerLeaseId ?? null) !== metadata.expectedOwnerLeaseId) ||
        isTerminalStatus(current.status) ||
        current.status === "cancel_requested"
      ) {
        return current;
      }
      const job = await this.updateJobUnlocked(id, {
        submissionState: state,
        ...(metadata.conversationId === undefined
          ? {}
          : { conversationId: metadata.conversationId }),
        ...(metadata.expectedHead === undefined ? {} : { expectedHead: metadata.expectedHead }),
        ...(metadata.reasonCode === undefined ? {} : { reasonCode: metadata.reasonCode }),
        ...(metadata.evidencePath === undefined ? {} : { evidencePath: metadata.evidencePath }),
      });
      await this.appendEventUnlocked(id, {
        id,
        level: state === "submission_unknown" ? "error" : "info",
        phase: job.phase,
        message: `Submission state: ${state}.`,
        reasonCode: metadata.reasonCode ?? state,
      });
      return await this.requireJob(id);
    });
  }

  async acquireOwnerLease(
    id: string,
    input: OracleJobOwnerLeaseInput,
  ): Promise<OracleJobRecord | null> {
    return await this.withLock(id, async () => {
      const current = await this.requireJob(id);
      if (
        (input.expectedGeneration !== undefined &&
          current.generation !== input.expectedGeneration) ||
        (input.expectedOwnerLeaseId !== undefined &&
          (current.ownerLeaseId ?? null) !== input.expectedOwnerLeaseId)
      ) {
        return null;
      }
      const now = new Date().toISOString();
      const lease: OracleJobOwnerLease = {
        generation: input.generation,
        leaseId: input.leaseId ?? `${id}-${randomBytes(8).toString("hex")}`,
        role: input.role,
        ownerPid: input.ownerPid,
        acquiredAt: now,
        expiresAt: input.expiresAt,
      };
      return await this.updateJobUnlocked(id, {
        generation: Math.max(current.generation, input.generation),
        ownerGeneration: input.generation,
        ownerLeaseId: lease.leaseId,
        ownerLease: lease,
      });
    });
  }
  async reconcileInterruptedJobs(): Promise<OracleJobRecord[]> {
    const jobs = await this.listJobs(Number.MAX_SAFE_INTEGER);
    const reconciled: OracleJobRecord[] = [];
    for (const job of jobs) {
      if (!isInterruptedStatus(job.status)) continue;
      const submitted =
        job.submissionState === "accepted" ||
        job.submissionState === "submitted" ||
        job.submissionState === "submission_unknown" ||
        Boolean(job.conversationId || job.expectedHead || job.runtime?.conversationUrl) ||
        job.phase === "submitting_prompt" ||
        job.phase === "waiting_for_response";
      const status: OracleJobStatus = submitted ? "requires_action" : "unknown";
      const outcome: OracleJobOutcome = submitted ? "requires_action" : "unknown";
      const reasonCode = submitted ? "submission_unknown" : "daemon_restarted";
      const actionRequired: OracleJobActionRequired | undefined = submitted
        ? {
            kind: "submission_unknown",
            message:
              "The daemon restarted after submission may have been acknowledged. Reopen the conversation and reconcile before retrying.",
            evidencePath: job.evidencePath ?? job.eventLogPath,
            details: {
              previousStatus: job.status,
              previousPhase: job.phase,
              submissionState: job.submissionState ?? "pre_submit",
              conversationId: job.conversationId,
              expectedHead: job.expectedHead,
            },
          }
        : undefined;
      const error: OracleJobError = {
        message: submitted
          ? "Daemon restarted while submission or remote work had an ambiguous outcome."
          : "Daemon restarted before this job completed; no retry was attempted.",
        code: reasonCode,
        reasonCode,
        retryable: false,
        ...(actionRequired ? { actionRequired } : {}),
        evidencePath: job.evidencePath ?? job.eventLogPath,
        evidence: {
          previousStatus: job.status,
          previousPhase: job.phase,
          daemonPid: job.runtime?.daemonPid,
          submissionState: job.submissionState,
        },
      };
      const next = await this.transitionJob({
        id: job.id,
        expectedStatus: job.status,
        nextStatus: status,
        phase: submitted ? "requires_action" : "unknown",
        message: submitted
          ? "Marked interrupted submitted job requires_action after daemon restart."
          : "Marked interrupted job unknown after daemon restart.",
        outcome,
        reasonCode,
        actionRequired,
        error,
      });
      if (next) reconciled.push(next);
    }
    return reconciled;
  }

  async pruneJobs(retentionMs: number): Promise<string[]> {
    const cutoff = Date.now() - retentionMs;
    const jobs = await this.listJobs(Number.MAX_SAFE_INTEGER);
    const deleted: string[] = [];
    for (const job of jobs) {
      await this.withLock(job.id, async () => {
        const current = await this.readJob(job.id);
        if (!current || !isTerminalStatus(current.status)) return;
        const completedAt = Date.parse(current.completedAt ?? current.updatedAt);
        if (Number.isNaN(completedAt) || completedAt >= cutoff) return;
        await fs.rm(this.jobDir(current.id), { recursive: true, force: true });
        this.withAdmissionDatabase((db) => {
          db.exec("BEGIN IMMEDIATE");
          try {
            db.prepare("DELETE FROM job_admissions WHERE job_id = ? AND status = 'terminal'").run(
              current.id,
            );
            db.prepare("DELETE FROM job_idempotency WHERE job_id = ?").run(current.id);
            db.exec("COMMIT");
          } catch (error) {
            try {
              db.exec("ROLLBACK");
            } catch {
              // Preserve the original prune error.
            }
            throw error;
          }
        });
        deleted.push(current.id);
      });
    }
    return deleted;
  }

  jobDir(id: string): string {
    if (!/^job_[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error(`Invalid Oracle job id: ${JSON.stringify(id)}.`);
    }
    return path.join(this.rootDir, id);
  }

  jobPath(id: string): string {
    return path.join(this.jobDir(id), "job.json");
  }

  private async requireJob(id: string): Promise<OracleJobRecord> {
    const job = await this.readJob(id);
    if (!job) throw new Error(`Oracle job ${id} was not found.`);
    return job;
  }

  private async updateJobUnlocked(
    id: string,
    patch: Partial<OracleJobRecord>,
  ): Promise<OracleJobRecord> {
    const current = await this.requireJob(id);
    const currentTime = Date.parse(current.updatedAt);
    const patchTime = patch.updatedAt ? Date.parse(patch.updatedAt) : Number.NaN;
    const nextUpdatedAt = new Date(
      Math.max(
        Number.isNaN(currentTime) ? 0 : currentTime,
        Number.isNaN(patchTime) ? 0 : patchTime,
        Date.now(),
      ),
    ).toISOString();
    const next: OracleJobRecord = {
      ...current,
      ...patch,
      id: current.id,
      kind: current.kind,
      createdAt: current.createdAt,
      inputPath: current.inputPath,
      eventLogPath: current.eventLogPath,
      inputBytes: patch.inputBytes ?? current.inputBytes ?? 0,
      attempt: patch.attempt ?? current.attempt ?? 0,
      generation: patch.generation ?? current.generation ?? 0,
      updatedAt: nextUpdatedAt,
    };
    await this.writeJob(next);
    this.withAdmissionDatabase((db) => {
      db.prepare(
        `UPDATE job_admissions
         SET status = ?, input_bytes = ?, principal_hash = ?, updated_at = ?
         WHERE job_id = ?`,
      ).run(
        isTerminalStatus(next.status) ? "terminal" : "active",
        next.inputBytes,
        next.principalHash ?? "anonymous",
        Date.now(),
        next.id,
      );
    });
    return next;
  }

  private async appendEventUnlocked(
    id: string,
    input: OracleJobEventInput,
  ): Promise<OracleJobEvent> {
    const job = await this.requireJob(id);
    const events = await this.readEvents(id);
    const previous = events.at(-1);
    const timestampMs = Math.max(
      previous ? Date.parse(previous.timestamp) : 0,
      input.timestamp ? Date.parse(input.timestamp) : 0,
      Date.now(),
    );
    const event: OracleJobEvent = {
      seq: (previous?.seq ?? 0) + 1,
      timestamp: new Date(timestampMs).toISOString(),
      level: input.level,
      phase: input.phase,
      message: input.message,
      ...(input.data === undefined ? {} : { data: input.data }),
      ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    };
    await fs.appendFile(job.eventLogPath, `${JSON.stringify(event)}\n`, "utf8");
    await this.updateJobUnlocked(id, {
      progress: { label: input.message, heartbeatAt: event.timestamp },
    });
    return event;
  }

  private async assertIdempotencyPayload(
    existing: OracleJobRecord,
    input: OracleJobCreateInput,
  ): Promise<void> {
    const existingInput = existing.requestHash ? undefined : await this.readInput(existing.id);
    const existingHash = existing.requestHash ?? requestHashForRecord(existing, existingInput);
    if (existingHash !== requestHashForInput(input)) {
      throw new OracleJobIdempotencyConflictError(existing.id);
    }
  }

  private claimIdempotencyKey(idempotencyKey: string, jobId: string, requestHash: string): boolean {
    return this.withIdempotencyDatabase((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db
          .prepare(
            `INSERT INTO job_idempotency (idempotency_key, job_id, request_hash)
             VALUES (?, ?, ?)
             ON CONFLICT (idempotency_key) DO NOTHING`,
          )
          .run(idempotencyKey, jobId, requestHash);
        db.exec("COMMIT");
        return Number(result.changes) === 1;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the original database error.
        }
        throw error;
      }
    });
  }

  private readIdempotencyIndex(
    idempotencyKey: string,
  ): { jobId: string; requestHash: string } | null {
    return this.withIdempotencyDatabase((db) => {
      const row = db
        .prepare(
          `SELECT job_id AS jobId, request_hash AS requestHash
           FROM job_idempotency WHERE idempotency_key = ?`,
        )
        .get(idempotencyKey) as { jobId?: unknown; requestHash?: unknown } | undefined;
      if (typeof row?.jobId !== "string" || typeof row.requestHash !== "string") return null;
      return { jobId: row.jobId, requestHash: row.requestHash };
    });
  }

  private removeIndexedIdempotencyKey(idempotencyKey: string, jobId: string): void {
    this.withIdempotencyDatabase((db) => {
      db.prepare("DELETE FROM job_idempotency WHERE idempotency_key = ? AND job_id = ?").run(
        idempotencyKey,
        jobId,
      );
    });
  }

  private insertLegacyIdempotencyKey(
    idempotencyKey: string,
    jobId: string,
    requestHash: string,
  ): void {
    this.withIdempotencyDatabase((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT INTO job_idempotency (idempotency_key, job_id, request_hash)
           VALUES (?, ?, ?)
           ON CONFLICT (idempotency_key) DO UPDATE SET
             job_id = CASE
               WHEN excluded.job_id < job_idempotency.job_id THEN excluded.job_id
               ELSE job_idempotency.job_id
             END,
             request_hash = CASE
               WHEN excluded.job_id < job_idempotency.job_id THEN excluded.request_hash
               ELSE job_idempotency.request_hash
             END`,
        ).run(idempotencyKey, jobId, requestHash);
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the original database error.
        }
        throw error;
      }
    });
  }

  private withIdempotencyDatabase<T>(callback: (db: DatabaseSync) => T): T {
    return this.withAdmissionDatabase(callback);
  }

  private async removeOtherPendingAdmissions(
    idempotencyKey: string,
    winnerId: string,
  ): Promise<void> {
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() && entry.name.startsWith("job_") && entry.name !== winnerId,
        )
        .map(async (entry) => {
          const markerPath = path.join(this.jobDir(entry.name), ADMISSION_PENDING_FILE);
          try {
            const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as {
              idempotencyKey?: unknown;
            };
            if (marker.idempotencyKey === idempotencyKey) {
              await fs.rm(this.jobDir(entry.name), { recursive: true, force: true });
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
          }
        }),
    );
  }

  private async withLock<T>(id: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.locks.set(id, chained);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (this.locks.get(id) === chained) this.locks.delete(id);
    }
  }

  private async writeJob(job: OracleJobRecord): Promise<void> {
    await fs.mkdir(this.jobDir(job.id), { recursive: true });
    await atomicWriteJson(this.jobPath(job.id), job);
  }
}

function isTerminalStatus(status: OracleJobStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "unknown" ||
    status === "conflict" ||
    status === "requires_action"
  );
}

function isInterruptedStatus(status: OracleJobStatus): boolean {
  return (
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting_for_model" ||
    status === "extracting_artifacts" ||
    status === "cancel_requested"
  );
}

function outcomeForStatus(status: OracleJobStatus): OracleJobOutcome | undefined {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "failure";
    case "cancelled":
      return "cancelled";
    case "unknown":
      return "unknown";
    case "conflict":
      return "conflict";
    case "requires_action":
      return "requires_action";
    default:
      return undefined;
  }
}

export function defaultJobRootDir(): string {
  return path.join(getOracleHomeDir(), "jobs");
}

export function createSortableJobId(date = new Date()): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `job_${stamp}_${randomBytes(4).toString("hex")}`;
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteText(filePath, serializePersistedJson(value));
}

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  const handle = await fs.open(
    tempPath,
    constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync().catch(() => {});
  } finally {
    await handle.close();
  }
  try {
    await replaceFile(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function replaceFile(tempPath: string, filePath: string): Promise<void> {
  const deadline = Date.now() + (process.platform === "win32" ? 5_000 : 0);
  let delayMs = 10;
  while (true) {
    try {
      await fs.rename(tempPath, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        (code !== "EPERM" && code !== "EACCES") ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 250);
    }
  }
}

function serializePersistedJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requestHashForInput(input: OracleJobCreateInput): string {
  return createHash("sha256")
    .update(
      stableJson({
        kind: input.kind,
        input: input.input,
        inputSummary: input.inputSummary ?? summarizeJobInput(input.input),
        conversationId: input.conversationId,
        expectedHead: input.expectedHead,
      }),
    )
    .digest("hex");
}

function requestHashForRecord(record: OracleJobRecord, input: unknown): string {
  return createHash("sha256")
    .update(
      stableJson({
        kind: record.kind,
        input,
        inputSummary: record.inputSummary,
        conversationId: record.conversationId,
        expectedHead: record.expectedHead,
      }),
    )
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function summarizeJobInput(input: unknown) {
  if (!input || typeof input !== "object") return {};
  const record = input as {
    prompt?: string;
    files?: unknown[];
    outputDir?: string;
    browserModelLabel?: string;
    browserThinkingTime?: string;
    projectUrl?: string;
    returnAfterSubmit?: boolean;
  };
  return {
    ...(typeof record.prompt === "string" ? { promptChars: record.prompt.length } : {}),
    ...(Array.isArray(record.files) ? { attachmentCount: record.files.length } : {}),
    ...(typeof record.outputDir === "string" ? { outputDir: record.outputDir } : {}),
    ...(typeof record.browserModelLabel === "string"
      ? { modelLabel: record.browserModelLabel }
      : {}),
    ...(typeof record.browserThinkingTime === "string"
      ? { thinkingTime: record.browserThinkingTime }
      : {}),
    ...(typeof record.projectUrl === "string" ? { projectUrl: record.projectUrl } : {}),
    ...(typeof record.returnAfterSubmit === "boolean"
      ? { returnAfterSubmit: record.returnAfterSubmit }
      : {}),
  };
}

function summarizeResult(result: unknown) {
  const record = result as {
    answerText?: string;
    answerMarkdown?: string;
    artifacts?: unknown[];
    downloadedArtifacts?: unknown[];
    downloadedSandboxArtifacts?: unknown[];
    warnings?: unknown[];
  };
  const text = typeof record?.answerText === "string" ? record.answerText : record?.answerMarkdown;
  return {
    ...(typeof text === "string" ? { answerChars: text.length } : {}),
    ...(Array.isArray(record?.artifacts) ? { imageArtifacts: record.artifacts.length } : {}),
    ...(Array.isArray(record?.downloadedArtifacts)
      ? { sandboxArtifacts: record.downloadedArtifacts.length }
      : {}),
    ...(Array.isArray(record?.downloadedSandboxArtifacts)
      ? { sandboxArtifacts: record.downloadedSandboxArtifacts.length }
      : {}),
    ...(Array.isArray(record?.warnings) ? { warnings: record.warnings.length } : {}),
  };
}

export function tempJobRootForTest(prefix = "oracle-jobs-"): string {
  return path.join(os.tmpdir(), `${prefix}${process.pid}-${Date.now()}`);
}
