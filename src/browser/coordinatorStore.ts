import { mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { getOracleHomeDir } from "../oracleHome.js";

/**
 * The coordinator database is intentionally metadata-only. Requests, prompts, response
 * bodies, and artifact contents belong on disk and are represented here only by hashes and
 * paths.
 */
export const COORDINATOR_SCHEMA_VERSION = 2;
export const DEFAULT_COORDINATOR_BUSY_TIMEOUT_MS = 5_000;
export const DEFAULT_COORDINATOR_STALE_OWNER_MS = 30_000;
export const DEFAULT_COORDINATOR_MAX_RESOURCE_SAMPLES = 256;
export const DEFAULT_COORDINATOR_TARGET_CEILING = 3;
export const MAX_COORDINATOR_METADATA_TEXT_BYTES = 8 * 1024;

export type BrowserCoordinatorProfileState = "running" | "stopped";
export type BrowserCoordinatorTargetState = "admitted" | "active" | "closing" | "closed" | "lost";
export type BrowserCoordinatorTargetRole =
  | "mutation"
  | "polling"
  | "recovery"
  | "auth"
  | "auxiliary"
  | (string & {});
export type BrowserCoordinatorJobState = string & {};

/** Stable outcome labels used by the coordinator when a turn cannot be treated as success/failure. */
export type BrowserCoordinatorJobOutcome =
  | "success"
  | "failure"
  | "cancel"
  | "unknown"
  | "conflict"
  | "requires_action";

export type BrowserCoordinatorResourceGatePhase = "normal" | "soft" | "hard" | "unknown";

export const BROWSER_COORDINATOR_TERMINAL_OUTCOMES = [
  "success",
  "failure",
  "cancel",
  "unknown",
  "conflict",
  "requires_action",
] as const satisfies readonly BrowserCoordinatorJobOutcome[];

export interface BrowserCoordinatorTargetCeilings {
  total?: number;
  roles?: Partial<Record<BrowserCoordinatorTargetRole, number>>;
  [role: string]: number | Partial<Record<BrowserCoordinatorTargetRole, number>> | undefined;
}

export interface BrowserCoordinatorStoreOptions {
  profileId: string;
  profilePath?: string;
  databasePath?: string;
  resolveDatabasePath?: (profileId: string, profilePath?: string) => string;
  busyTimeoutMs?: number;
  staleOwnerMs?: number;
  targetCeilings?: BrowserCoordinatorTargetCeilings;
  maxResourceSamples?: number;
  now?: () => number;
}

export interface BrowserCoordinatorResourceGate {
  profileId: string;
  generation: number | null;
  phase: BrowserCoordinatorResourceGatePhase;
  reason: string;
  processTreeRssBytes: number | null;
  rssSoftBytes: number;
  rssHardBytes: number;
  rssResumeBytes: number;
  sampledAt: number;
}

export interface UpsertResourceGateInput {
  generation?: number | null;
  phase: BrowserCoordinatorResourceGatePhase;
  reason: string;
  processTreeRssBytes?: number | null;
  rssSoftBytes: number;
  rssHardBytes: number;
  rssResumeBytes: number;
  sampledAt?: number;
}

export interface BrowserCoordinatorProfile {
  profileId: string;
  path: string | null;
  generation: number;
  ownerPid: number | null;
  ownerStartToken: string | null;
  browserPid: number | null;
  devtoolsEndpoint: string | null;
  state: BrowserCoordinatorProfileState;
  heartbeatAt: number | null;
}

export interface ClaimProfileGenerationInput {
  ownerPid: number;
  ownerStartToken: string;
  now?: number;
  staleOwnerMs?: number;
  takeover?: boolean;
  browserPid?: number | null;
  devtoolsEndpoint?: string | null;
}

export type ProfileGenerationClaimReason =
  | "claimed"
  | "already_owner"
  | "owner_active"
  | "takeover_required";

export interface BrowserCoordinatorGenerationClaim {
  claimed: boolean;
  generation: number;
  takeover: boolean;
  reason: ProfileGenerationClaimReason;
  profile: BrowserCoordinatorProfile;
}

export interface HeartbeatProfileInput {
  generation: number;
  ownerPid: number;
  ownerStartToken: string;
  now?: number;
  browserPid?: number | null;
  devtoolsEndpoint?: string | null;
}

export interface BrowserCoordinatorTarget {
  targetId: string;
  reservationId: string;
  profileId: string;
  generation: number;
  role: BrowserCoordinatorTargetRole;
  ownerJobId: string | null;
  state: BrowserCoordinatorTargetState;
  url: string | null;
  createdAt: number;
  lastSeenAt: number;
}

export interface AdmitTargetInput {
  targetId?: string;
  reservationId?: string;
  generation: number;
  role: BrowserCoordinatorTargetRole;
  ownerJobId?: string | null;
  state?: BrowserCoordinatorTargetState;
  url?: string | null;
  now?: number;
}

export type TargetAdmissionReason =
  | "admitted"
  | "target_exists"
  | "reservation_exists"
  | "generation_mismatch"
  | "resource_soft"
  | "resource_hard"
  | "resource_unknown"
  | "total_ceiling"
  | "role_ceiling";

export interface BrowserCoordinatorTargetAdmission {
  admitted: boolean;
  reason: TargetAdmissionReason;
  reservationId: string | null;
  target: BrowserCoordinatorTarget | null;
  activeTargetCount: number;
  activeRoleCount: number;
}

export interface BindTargetReservationInput {
  reservationId: string;
  targetId: string;
  generation: number;
  url?: string | null;
  now?: number;
}

export type TargetBindingReason =
  | "bound"
  | "already_bound"
  | "reservation_missing"
  | "generation_mismatch"
  | "target_exists";

export interface BrowserCoordinatorTargetBinding {
  bound: boolean;
  reason: TargetBindingReason;
  target: BrowserCoordinatorTarget | null;
}

export interface UpdateTargetInput {
  targetId: string;
  generation: number;
  state?: BrowserCoordinatorTargetState;
  url?: string | null;
  now?: number;
}

export interface BrowserCoordinatorJob {
  jobId: string;
  profileId: string | null;
  operation: string;
  state: BrowserCoordinatorJobState;
  reasonCode: string | null;
  requestHash: string | null;
  conversationId: string | null;
  expectedHead: string | null;
  ownerGeneration: number | null;
  ownerLeaseId: string | null;
  idempotencyKey: string | null;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  retryPolicy: string | null;
}

export interface CreateJobInput {
  jobId?: string;
  operation: string;
  state?: BrowserCoordinatorJobState;
  reasonCode?: string | null;
  requestHash?: string | null;
  conversationId?: string | null;
  expectedHead?: string | null;
  ownerGeneration?: number | null;
  ownerLeaseId?: string | null;
  idempotencyKey?: string | null;
  attempt?: number;
  retryPolicy?: string | null;
  now?: number;
}

export interface TransitionJobInput {
  jobId: string;
  expectedState: BrowserCoordinatorJobState;
  nextState: BrowserCoordinatorJobState;
  expectedOwnerGeneration?: number | null;
  ownerGeneration?: number | null;
  expectedOwnerLeaseId?: string | null;
  ownerLeaseId?: string | null;
  attempt?: number;
  reasonCode?: string | null;
  evidencePath?: string | null;
  now?: number;
}

export interface BrowserCoordinatorJobEvent {
  jobId: string;
  sequence: number;
  state: BrowserCoordinatorJobState;
  reasonCode: string | null;
  evidencePath: string | null;
  timestamp: number;
}

export interface AppendJobEventInput {
  jobId: string;
  state: BrowserCoordinatorJobState;
  reasonCode?: string | null;
  evidencePath?: string | null;
  timestamp?: number;
}

export interface BrowserCoordinatorAttachment {
  attachmentId: string;
  jobId: string;
  path: string;
  size: number;
  mediaType: string | null;
  sha256: string | null;
  remoteFileId: string | null;
  observedState: string | null;
}

export interface AddAttachmentInput {
  attachmentId?: string;
  jobId: string;
  path: string;
  size: number;
  mediaType?: string | null;
  sha256?: string | null;
  remoteFileId?: string | null;
  observedState?: string | null;
}

export interface BrowserCoordinatorArtifact {
  artifactId: string;
  jobId: string;
  kind: string;
  sourceUrl: string | null;
  path: string | null;
  size: number | null;
  sha256: string | null;
  turnId: string | null;
}

export interface AddArtifactInput {
  artifactId?: string;
  jobId: string;
  kind: string;
  sourceUrl?: string | null;
  path?: string | null;
  size?: number | null;
  sha256?: string | null;
  turnId?: string | null;
}

export interface BrowserCoordinatorRateLimit {
  key: string;
  limit: number | null;
  remaining: number | null;
  resetAt: number | null;
  retryAfter: number | null;
  updatedAt: number;
}

export interface UpsertRateLimitInput {
  key: string;
  limit?: number | null;
  remaining?: number | null;
  resetAt?: number | null;
  retryAfter?: number | null;
  now?: number;
}

export interface BrowserCoordinatorResourceSample {
  sampleId: number;
  profileId: string;
  generation: number | null;
  sampledAt: number;
  processTreeRssBytes: number;
  processTreeCpuTimeMs: number | null;
  chromePid: number | null;
  processCount: number | null;
}

export interface AppendResourceSampleInput {
  generation?: number | null;
  sampledAt?: number;
  processTreeRssBytes: number;
  processTreeCpuTimeMs?: number | null;
  chromePid?: number | null;
  processCount?: number | null;
}

export function defaultCoordinatorDatabasePath(profilePath: string): string {
  return path.join(profilePath, "coordinator.sqlite");
}

export function defaultCoordinatorProfilePath(profileId: string): string {
  const slug = createHash("sha256").update(profileId).digest("hex").slice(0, 24);
  return path.join(getOracleHomeDir(), "browser-coordinator", slug);
}

const ACTIVE_TARGET_STATES = ["admitted", "active", "closing"] as const;

export class BrowserCoordinatorStore {
  readonly profileId: string;
  readonly databasePath: string;
  readonly busyTimeoutMs: number;
  readonly maxResourceSamples: number;
  #db: DatabaseSync;
  #closed = false;
  #clock: () => number;
  #staleOwnerMs: number;
  #targetCeilings: BrowserCoordinatorTargetCeilings;
  #profilePathValue: string | null;

  constructor(options: BrowserCoordinatorStoreOptions) {
    if (!options.profileId.trim()) throw new Error("Coordinator profileId must not be empty.");
    this.profileId = options.profileId;
    this.busyTimeoutMs = positiveInteger(
      options.busyTimeoutMs ?? DEFAULT_COORDINATOR_BUSY_TIMEOUT_MS,
      "busyTimeoutMs",
    );
    this.#staleOwnerMs = positiveInteger(
      options.staleOwnerMs ?? DEFAULT_COORDINATOR_STALE_OWNER_MS,
      "staleOwnerMs",
    );
    this.maxResourceSamples = positiveInteger(
      options.maxResourceSamples ?? DEFAULT_COORDINATOR_MAX_RESOURCE_SAMPLES,
      "maxResourceSamples",
    );
    this.#clock = options.now ?? Date.now;
    this.#profilePathValue = options.profilePath ?? null;
    this.#targetCeilings = normalizeTargetCeilings(options.targetCeilings);
    this.databasePath =
      options.databasePath ??
      options.resolveDatabasePath?.(this.profileId, options.profilePath) ??
      defaultCoordinatorDatabasePath(
        options.profilePath ?? defaultCoordinatorProfilePath(this.profileId),
      );
    mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true });
    try {
      this.#db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs};`);
      this.#db.exec("PRAGMA journal_mode = WAL;");
      this.#initializeSchema();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  getProfile(): BrowserCoordinatorProfile | null {
    this.#assertOpen();
    return this.#readProfile();
  }

  claimProfileGeneration(input: ClaimProfileGenerationInput): BrowserCoordinatorGenerationClaim {
    this.#assertOpen();
    assertOwner(input.ownerPid, input.ownerStartToken);
    const now = finiteTimestamp(input.now ?? this.#clock());
    const staleOwnerMs = positiveInteger(input.staleOwnerMs ?? this.#staleOwnerMs, "staleOwnerMs");
    return this.#transaction(() => {
      const existing = this.#readProfile();
      if (!existing) {
        this.#db
          .prepare(
            `INSERT INTO profiles
              (profile_id, path, generation, owner_pid, owner_start_token, browser_pid,
               devtools_endpoint, state, heartbeat_at)
             VALUES (?, ?, 1, ?, ?, ?, ?, 'running', ?)`,
          )
          .run(
            this.profileId,
            this.#profilePath(),
            input.ownerPid,
            input.ownerStartToken,
            input.browserPid ?? null,
            input.devtoolsEndpoint ?? null,
            now,
          );
        return this.#claimResult("claimed", false, this.#readProfileOrThrow());
      }

      if (existing.state === "stopped") {
        const generation = existing.generation + 1;
        this.#db
          .prepare(
            `UPDATE profiles
             SET generation = ?, owner_pid = ?, owner_start_token = ?, browser_pid = ?,
                 devtools_endpoint = ?, state = 'running', heartbeat_at = ?
             WHERE profile_id = ? AND generation = ? AND state = 'stopped'`,
          )
          .run(
            generation,
            input.ownerPid,
            input.ownerStartToken,
            input.browserPid ?? null,
            input.devtoolsEndpoint ?? null,
            now,
            this.profileId,
            existing.generation,
          );
        return this.#claimResult("claimed", true, this.#readProfileOrThrow());
      }

      const sameOwner =
        existing.ownerPid === input.ownerPid && existing.ownerStartToken === input.ownerStartToken;
      if (sameOwner) {
        this.#db
          .prepare(
            `UPDATE profiles SET state = 'running', heartbeat_at = ?, browser_pid = ?, devtools_endpoint = ?
             WHERE profile_id = ? AND generation = ? AND owner_pid = ? AND owner_start_token = ?`,
          )
          .run(
            now,
            input.browserPid ?? existing.browserPid,
            input.devtoolsEndpoint ?? existing.devtoolsEndpoint,
            this.profileId,
            existing.generation,
            input.ownerPid,
            input.ownerStartToken,
          );
        return this.#claimResult("already_owner", false, this.#readProfileOrThrow());
      }

      const stale = existing.heartbeatAt === null || now - existing.heartbeatAt >= staleOwnerMs;
      if (!stale) return this.#claimResult("owner_active", false, existing);
      if (!input.takeover) return this.#claimResult("takeover_required", false, existing);

      const generation = existing.generation + 1;
      this.#db
        .prepare(
          `UPDATE profiles
           SET generation = ?, owner_pid = ?, owner_start_token = ?, browser_pid = ?,
               devtools_endpoint = ?, state = 'running', heartbeat_at = ?
           WHERE profile_id = ? AND generation = ? AND owner_pid IS ? AND owner_start_token IS ?`,
        )
        .run(
          generation,
          input.ownerPid,
          input.ownerStartToken,
          input.browserPid ?? null,
          input.devtoolsEndpoint ?? null,
          now,
          this.profileId,
          existing.generation,
          existing.ownerPid,
          existing.ownerStartToken,
        );
      return this.#claimResult("claimed", true, this.#readProfileOrThrow());
    });
  }

  heartbeatProfile(input: HeartbeatProfileInput): boolean {
    this.#assertOpen();
    assertOwner(input.ownerPid, input.ownerStartToken);
    validateGeneration(input.generation, "generation");
    const now = finiteTimestamp(input.now ?? this.#clock());
    return this.#transaction(() => {
      const result = this.#db
        .prepare(
          `UPDATE profiles
           SET state = 'running', heartbeat_at = ?, browser_pid = COALESCE(?, browser_pid),
               devtools_endpoint = COALESCE(?, devtools_endpoint)
           WHERE profile_id = ? AND generation = ? AND owner_pid = ? AND owner_start_token = ?`,
        )
        .run(
          now,
          input.browserPid ?? null,
          input.devtoolsEndpoint ?? null,
          this.profileId,
          input.generation,
          input.ownerPid,
          input.ownerStartToken,
        );
      return Number(result.changes) === 1;
    });
  }

  releaseProfile(input: HeartbeatProfileInput): boolean {
    this.#assertOpen();
    assertOwner(input.ownerPid, input.ownerStartToken);
    validateGeneration(input.generation, "generation");
    return this.#transaction(() => {
      const result = this.#db
        .prepare(
          `UPDATE profiles
           SET state = 'stopped', owner_pid = NULL, owner_start_token = NULL,
               browser_pid = NULL, devtools_endpoint = NULL, heartbeat_at = NULL
           WHERE profile_id = ? AND generation = ? AND owner_pid = ? AND owner_start_token = ?`,
        )
        .run(this.profileId, input.generation, input.ownerPid, input.ownerStartToken);
      return Number(result.changes) === 1;
    });
  }

  admitTarget(input: AdmitTargetInput): BrowserCoordinatorTargetAdmission {
    this.#assertOpen();
    validateGeneration(input.generation, "generation");
    const reservationId = input.reservationId ?? `reservation_${randomUUID()}`;
    const targetId = input.targetId ?? reservationId;
    validateMetadata(reservationId, "reservationId");
    const now = finiteTimestamp(input.now ?? this.#clock());
    const state = input.state ?? "admitted";
    validateTargetInput(targetId, input.role, state, input.url);
    return this.#transaction(() => {
      const profile = this.#readProfileOrThrow();
      if (profile.generation !== input.generation) {
        return {
          admitted: false,
          reason: "generation_mismatch",
          reservationId,
          target: null,
          activeTargetCount: this.#countActiveTargets(undefined, profile.generation),
          activeRoleCount: this.#countActiveTargets(input.role, profile.generation),
        };
      }
      const resourceGate = this.#readResourceGate();
      if (
        resourceGate &&
        (resourceGate.generation === null || resourceGate.generation === profile.generation) &&
        resourceGate.phase !== "normal" &&
        !(resourceGate.phase === "soft" && input.role === "recovery")
      ) {
        return {
          admitted: false,
          reason: `resource_${resourceGate.phase}` as TargetAdmissionReason,
          reservationId,
          target: null,
          activeTargetCount: this.#countActiveTargets(undefined, profile.generation),
          activeRoleCount: this.#countActiveTargets(input.role, profile.generation),
        };
      }
      const duplicateTarget = this.#db
        .prepare("SELECT 1 AS present FROM targets WHERE target_id = ?")
        .get(targetId);
      if (duplicateTarget) {
        return {
          admitted: false,
          reason: "target_exists",
          reservationId,
          target: null,
          activeTargetCount: this.#countActiveTargets(undefined, profile.generation),
          activeRoleCount: this.#countActiveTargets(input.role, profile.generation),
        };
      }
      const duplicateReservation = this.#db
        .prepare("SELECT 1 AS present FROM targets WHERE reservation_id = ?")
        .get(reservationId);
      if (duplicateReservation) {
        return {
          admitted: false,
          reason: "reservation_exists",
          reservationId,
          target: null,
          activeTargetCount: this.#countActiveTargets(undefined, profile.generation),
          activeRoleCount: this.#countActiveTargets(input.role, profile.generation),
        };
      }
      const activeTargetCount = this.#countActiveTargets(undefined, profile.generation);
      const activeRoleCount = this.#countActiveTargets(input.role, profile.generation);
      const roleCeiling = this.#roleCeiling(input.role);
      if (activeTargetCount >= this.#totalCeiling()) {
        return {
          admitted: false,
          reason: "total_ceiling",
          reservationId,
          target: null,
          activeTargetCount,
          activeRoleCount,
        };
      }
      if (roleCeiling !== null && activeRoleCount >= roleCeiling) {
        return {
          admitted: false,
          reason: "role_ceiling",
          reservationId,
          target: null,
          activeTargetCount,
          activeRoleCount,
        };
      }
      this.#db
        .prepare(
          `INSERT INTO targets
            (target_id, reservation_id, profile_id, generation, role, owner_job_id, state, url, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          targetId,
          reservationId,
          this.profileId,
          input.generation,
          input.role,
          input.ownerJobId ?? null,
          state,
          input.url ?? null,
          now,
          now,
        );
      const target = this.#readTarget(targetId);
      return {
        admitted: true,
        reason: "admitted",
        reservationId,
        target,
        activeTargetCount: activeTargetCount + 1,
        activeRoleCount: activeRoleCount + 1,
      };
    });
  }

  bindTargetReservation(input: BindTargetReservationInput): BrowserCoordinatorTargetBinding {
    this.#assertOpen();
    validateGeneration(input.generation, "generation");
    validateMetadata(input.reservationId, "reservationId");
    validateMetadata(input.targetId, "targetId");
    validateOptionalMetadata(input.url, "url");
    const now = finiteTimestamp(input.now ?? this.#clock());
    return this.#transaction(() => {
      const reservation = this.#db
        .prepare(
          `SELECT target_id, generation FROM targets
           WHERE profile_id = ? AND reservation_id = ?`,
        )
        .get(this.profileId, input.reservationId) as
        | { target_id?: unknown; generation?: unknown }
        | undefined;
      if (!reservation) return { bound: false, reason: "reservation_missing", target: null };
      if (Number(reservation.generation) !== input.generation) {
        return { bound: false, reason: "generation_mismatch", target: null };
      }
      const existingTarget = this.#db
        .prepare("SELECT 1 AS present FROM targets WHERE target_id = ?")
        .get(input.targetId);
      const currentTargetId = String(reservation.target_id);
      if (currentTargetId !== input.reservationId && currentTargetId !== input.targetId) {
        return {
          bound: false,
          reason: "already_bound",
          target: this.#readTarget(currentTargetId),
        };
      }
      if (existingTarget && input.targetId !== currentTargetId) {
        return { bound: false, reason: "target_exists", target: null };
      }
      this.#db
        .prepare(
          `UPDATE targets
           SET target_id = ?, state = 'active', url = COALESCE(?, url), last_seen_at = ?
           WHERE profile_id = ? AND reservation_id = ? AND generation = ? AND target_id = ?`,
        )
        .run(
          input.targetId,
          input.url ?? null,
          now,
          this.profileId,
          input.reservationId,
          input.generation,
          currentTargetId,
        );
      return {
        bound: true,
        reason: "bound",
        target: this.#readTarget(input.targetId),
      };
    });
  }

  updateTarget(input: UpdateTargetInput): BrowserCoordinatorTarget | null {
    this.#assertOpen();
    validateGeneration(input.generation, "generation");
    const now = finiteTimestamp(input.now ?? this.#clock());
    return this.#transaction(() => {
      const result = this.#db
        .prepare(
          `UPDATE targets
           SET state = COALESCE(?, state), url = COALESCE(?, url), last_seen_at = ?
           WHERE target_id = ? AND profile_id = ? AND generation = ?`,
        )
        .run(
          input.state ?? null,
          input.url ?? null,
          now,
          input.targetId,
          this.profileId,
          input.generation,
        );
      return Number(result.changes) === 1 ? this.#readTarget(input.targetId) : null;
    });
  }

  listTargets(): BrowserCoordinatorTarget[] {
    this.#assertOpen();
    return this.#db
      .prepare(
        `SELECT target_id, reservation_id, profile_id, generation, role, owner_job_id, state, url, created_at, last_seen_at
         FROM targets WHERE profile_id = ? ORDER BY created_at, target_id`,
      )
      .all(this.profileId)
      .map((row) => targetFromRow(row));
  }

  createJob(input: CreateJobInput): BrowserCoordinatorJob {
    this.#assertOpen();
    const jobId = input.jobId ?? `job_${randomUUID()}`;
    const now = finiteTimestamp(input.now ?? this.#clock());
    const state = input.state ?? "queued";
    const attempt = input.attempt ?? 0;
    validateMetadata(jobId, "jobId");
    validateMetadata(input.operation, "operation");
    validateOptionalMetadata(input.reasonCode, "reasonCode");
    validateOptionalMetadata(input.requestHash, "requestHash");
    validateOptionalMetadata(input.conversationId, "conversationId");
    validateOptionalMetadata(input.expectedHead, "expectedHead");
    validateOptionalMetadata(input.ownerLeaseId, "ownerLeaseId");
    validateOptionalMetadata(input.idempotencyKey, "idempotencyKey");
    validateOptionalMetadata(input.retryPolicy, "retryPolicy");
    validateAttempt(attempt);
    if (input.ownerGeneration !== undefined && input.ownerGeneration !== null) {
      validateGeneration(input.ownerGeneration, "ownerGeneration");
    }
    return this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO jobs
            (job_id, profile_id, operation, state, reason_code, request_hash, conversation_id,
             expected_head, owner_generation, owner_lease_id, idempotency_key, attempt,
             created_at, updated_at, retry_policy)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          jobId,
          this.profileId,
          input.operation,
          state,
          input.reasonCode ?? null,
          input.requestHash ?? null,
          input.conversationId ?? null,
          input.expectedHead ?? null,
          input.ownerGeneration ?? null,
          input.ownerLeaseId ?? null,
          input.idempotencyKey ?? null,
          attempt,
          now,
          now,
          input.retryPolicy ?? null,
        );
      this.#insertEvent(jobId, state, input.reasonCode ?? null, null, now);
      return this.#readJobOrThrow(jobId);
    });
  }

  getJob(jobId: string): BrowserCoordinatorJob | null {
    this.#assertOpen();
    return this.#readJob(jobId);
  }

  getJobByIdempotencyKey(idempotencyKey: string): BrowserCoordinatorJob | null {
    this.#assertOpen();
    validateMetadata(idempotencyKey, "idempotencyKey");
    const row = this.#db
      .prepare(
        `SELECT job_id, profile_id, operation, state, reason_code, request_hash, conversation_id,
                expected_head, owner_generation, owner_lease_id, idempotency_key, attempt,
                created_at, updated_at, retry_policy
         FROM jobs WHERE profile_id = ? AND idempotency_key = ?`,
      )
      .get(this.profileId, idempotencyKey);
    return row ? jobFromRow(row) : null;
  }

  transitionJob(input: TransitionJobInput): BrowserCoordinatorJob | null {
    this.#assertOpen();
    const now = finiteTimestamp(input.now ?? this.#clock());
    validateMetadata(input.jobId, "jobId");
    validateMetadata(input.expectedState, "expectedState");
    validateMetadata(input.nextState, "nextState");
    validateOptionalMetadata(input.reasonCode, "reasonCode");
    validateOptionalMetadata(input.evidencePath, "evidencePath");
    validateOptionalMetadata(input.expectedOwnerLeaseId, "expectedOwnerLeaseId");
    validateOptionalMetadata(input.ownerLeaseId, "ownerLeaseId");
    if (input.attempt !== undefined) validateAttempt(input.attempt);
    if (input.expectedOwnerGeneration !== undefined && input.expectedOwnerGeneration !== null) {
      validateGeneration(input.expectedOwnerGeneration, "expectedOwnerGeneration");
    }
    if (input.ownerGeneration !== undefined && input.ownerGeneration !== null) {
      validateGeneration(input.ownerGeneration, "ownerGeneration");
    }
    return this.#transaction(() => {
      const current = this.#readJob(input.jobId);
      if (!current || current.state !== input.expectedState) return null;
      if (
        input.expectedOwnerGeneration !== undefined &&
        current.ownerGeneration !== input.expectedOwnerGeneration
      ) {
        return null;
      }
      if (
        input.expectedOwnerLeaseId !== undefined &&
        current.ownerLeaseId !== input.expectedOwnerLeaseId
      ) {
        return null;
      }
      const nextOwnerGeneration =
        input.ownerGeneration !== undefined ? input.ownerGeneration : current.ownerGeneration;
      const nextOwnerLeaseId =
        input.ownerLeaseId !== undefined ? input.ownerLeaseId : current.ownerLeaseId;
      const nextAttempt = input.attempt ?? current.attempt;
      const where = ["job_id = ?", "state = ?"];
      const parameters: Array<string | number | null> = [
        input.nextState,
        input.reasonCode !== undefined ? input.reasonCode : current.reasonCode,
        nextOwnerGeneration,
        nextOwnerLeaseId,
        nextAttempt,
        Math.max(now, current.updatedAt),
        input.jobId,
        input.expectedState,
      ];
      if (input.expectedOwnerGeneration !== undefined) {
        where.push("owner_generation IS ?");
        parameters.push(input.expectedOwnerGeneration);
      }
      if (input.expectedOwnerLeaseId !== undefined) {
        where.push("owner_lease_id IS ?");
        parameters.push(input.expectedOwnerLeaseId);
      }
      const result = this.#db
        .prepare(
          `UPDATE jobs
           SET state = ?, reason_code = ?, owner_generation = ?, owner_lease_id = ?,
               attempt = ?, updated_at = ?
           WHERE ${where.join(" AND ")}`,
        )
        .run(...parameters);
      if (Number(result.changes) !== 1) return null;
      this.#insertEvent(
        input.jobId,
        input.nextState,
        input.reasonCode !== undefined ? input.reasonCode : current.reasonCode,
        input.evidencePath ?? null,
        Math.max(now, current.updatedAt),
      );
      return this.#readJobOrThrow(input.jobId);
    });
  }

  appendJobEvent(input: AppendJobEventInput): BrowserCoordinatorJobEvent {
    this.#assertOpen();
    validateMetadata(input.jobId, "jobId");
    validateMetadata(input.state, "state");
    validateOptionalMetadata(input.reasonCode, "reasonCode");
    validateOptionalMetadata(input.evidencePath, "evidencePath");
    const timestamp = finiteTimestamp(input.timestamp ?? this.#clock());
    return this.#transaction(() =>
      this.#insertEvent(
        input.jobId,
        input.state,
        input.reasonCode ?? null,
        input.evidencePath ?? null,
        timestamp,
      ),
    );
  }

  listJobEvents(jobId: string): BrowserCoordinatorJobEvent[] {
    this.#assertOpen();
    return this.#db
      .prepare(
        `SELECT job_id, sequence, state, reason_code, evidence_path, timestamp
         FROM job_events WHERE job_id = ? ORDER BY sequence`,
      )
      .all(jobId)
      .map((row) => eventFromRow(row));
  }

  addAttachment(input: AddAttachmentInput): BrowserCoordinatorAttachment {
    this.#assertOpen();
    const attachmentId = input.attachmentId ?? `attachment_${randomUUID()}`;
    validateMetadata(attachmentId, "attachmentId");
    validateMetadata(input.jobId, "jobId");
    validateMetadata(input.path, "path");
    validateOptionalMetadata(input.mediaType, "mediaType");
    validateOptionalMetadata(input.sha256, "sha256");
    validateOptionalMetadata(input.remoteFileId, "remoteFileId");
    validateOptionalMetadata(input.observedState, "observedState");
    validateSize(input.size, "size");
    return this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO attachments
            (attachment_id, job_id, path, size, media_type, sha256, remote_file_id, observed_state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attachmentId,
          input.jobId,
          input.path,
          input.size,
          input.mediaType ?? null,
          input.sha256 ?? null,
          input.remoteFileId ?? null,
          input.observedState ?? null,
        );
      return this.#readAttachmentOrThrow(attachmentId);
    });
  }

  listAttachments(jobId: string): BrowserCoordinatorAttachment[] {
    this.#assertOpen();
    return this.#db
      .prepare(
        `SELECT attachment_id, job_id, path, size, media_type, sha256, remote_file_id, observed_state
         FROM attachments WHERE job_id = ? ORDER BY attachment_id`,
      )
      .all(jobId)
      .map((row) => attachmentFromRow(row));
  }

  addArtifact(input: AddArtifactInput): BrowserCoordinatorArtifact {
    this.#assertOpen();
    const artifactId = input.artifactId ?? `artifact_${randomUUID()}`;
    validateMetadata(artifactId, "artifactId");
    validateMetadata(input.jobId, "jobId");
    validateMetadata(input.kind, "kind");
    validateOptionalMetadata(input.sourceUrl, "sourceUrl");
    validateOptionalMetadata(input.path, "path");
    validateOptionalMetadata(input.sha256, "sha256");
    validateOptionalMetadata(input.turnId, "turnId");
    if (input.size !== undefined && input.size !== null) validateSize(input.size, "size");
    return this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO artifacts
            (artifact_id, job_id, kind, source_url, path, size, sha256, turn_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifactId,
          input.jobId,
          input.kind,
          input.sourceUrl ?? null,
          input.path ?? null,
          input.size ?? null,
          input.sha256 ?? null,
          input.turnId ?? null,
        );
      return this.#readArtifactOrThrow(artifactId);
    });
  }

  listArtifacts(jobId: string): BrowserCoordinatorArtifact[] {
    this.#assertOpen();
    return this.#db
      .prepare(
        `SELECT artifact_id, job_id, kind, source_url, path, size, sha256, turn_id
         FROM artifacts WHERE job_id = ? ORDER BY artifact_id`,
      )
      .all(jobId)
      .map((row) => artifactFromRow(row));
  }

  upsertRateLimit(input: UpsertRateLimitInput): BrowserCoordinatorRateLimit {
    this.#assertOpen();
    validateMetadata(input.key, "rate-limit key");
    for (const [name, value] of [
      ["limit", input.limit],
      ["remaining", input.remaining],
      ["resetAt", input.resetAt],
      ["retryAfter", input.retryAfter],
    ] as const) {
      if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 0)) {
        throw new Error(`${name} must be a non-negative finite number.`);
      }
    }
    const now = finiteTimestamp(input.now ?? this.#clock());
    return this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO rate_limits (profile_id, key, limit_value, remaining, reset_at, retry_after, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(profile_id, key) DO UPDATE SET
             limit_value = excluded.limit_value, remaining = excluded.remaining,
             reset_at = excluded.reset_at, retry_after = excluded.retry_after, updated_at = excluded.updated_at`,
        )
        .run(
          this.profileId,
          input.key,
          input.limit ?? null,
          input.remaining ?? null,
          input.resetAt ?? null,
          input.retryAfter ?? null,
          now,
        );
      return this.#readRateLimitOrThrow(input.key);
    });
  }

  getRateLimit(key: string): BrowserCoordinatorRateLimit | null {
    this.#assertOpen();
    const row = this.#db
      .prepare(
        `SELECT key, limit_value, remaining, reset_at, retry_after, updated_at
         FROM rate_limits WHERE profile_id = ? AND key = ?`,
      )
      .get(this.profileId, key);
    return row ? rateLimitFromRow(row) : null;
  }

  appendResourceSample(input: AppendResourceSampleInput): BrowserCoordinatorResourceSample {
    this.#assertOpen();
    if (input.generation !== undefined && input.generation !== null) {
      validateGeneration(input.generation, "generation");
    }
    validateSize(input.processTreeRssBytes, "processTreeRssBytes");
    for (const [name, value] of [
      ["processTreeCpuTimeMs", input.processTreeCpuTimeMs],
      ["chromePid", input.chromePid],
      ["processCount", input.processCount],
    ] as const) {
      if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 0)) {
        throw new Error(`${name} must be a non-negative finite number.`);
      }
    }
    const sampledAt = finiteTimestamp(input.sampledAt ?? this.#clock());
    return this.#transaction(() => {
      const result = this.#db
        .prepare(
          `INSERT INTO resource_samples
            (profile_id, generation, sampled_at, process_tree_rss_bytes, process_tree_cpu_time_ms, chrome_pid, process_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.profileId,
          input.generation ?? null,
          sampledAt,
          input.processTreeRssBytes,
          input.processTreeCpuTimeMs ?? null,
          input.chromePid ?? null,
          input.processCount ?? null,
        );
      this.#db
        .prepare(
          `DELETE FROM resource_samples WHERE profile_id = ?
           AND sample_id NOT IN (
             SELECT sample_id FROM resource_samples WHERE profile_id = ?
             ORDER BY sampled_at DESC, sample_id DESC LIMIT ?
           )`,
        )
        .run(this.profileId, this.profileId, this.maxResourceSamples);
      const sampleId = Number(result.lastInsertRowid);
      return this.#readResourceSampleOrThrow(sampleId);
    });
  }

  listResourceSamples(limit = this.maxResourceSamples): BrowserCoordinatorResourceSample[] {
    this.#assertOpen();
    const boundedLimit = Math.min(this.maxResourceSamples, positiveInteger(limit, "limit"));
    return this.#db
      .prepare(
        `SELECT sample_id, profile_id, generation, sampled_at, process_tree_rss_bytes,
                process_tree_cpu_time_ms, chrome_pid, process_count
         FROM resource_samples WHERE profile_id = ?
         ORDER BY sampled_at DESC, sample_id DESC LIMIT ?`,
      )
      .all(this.profileId, boundedLimit)
      .map((row) => resourceSampleFromRow(row));
  }

  upsertResourceGate(input: UpsertResourceGateInput): BrowserCoordinatorResourceGate {
    this.#assertOpen();
    if (input.generation !== undefined && input.generation !== null) {
      validateGeneration(input.generation, "generation");
    }
    if (!["normal", "soft", "hard", "unknown"].includes(input.phase)) {
      throw new Error(`Unknown resource gate phase ${input.phase}.`);
    }
    validateMetadata(input.reason, "reason");
    if (input.processTreeRssBytes !== undefined && input.processTreeRssBytes !== null) {
      validateSize(input.processTreeRssBytes, "processTreeRssBytes");
    }
    validateSize(input.rssSoftBytes, "rssSoftBytes");
    validateSize(input.rssHardBytes, "rssHardBytes");
    validateSize(input.rssResumeBytes, "rssResumeBytes");
    if (input.rssResumeBytes >= input.rssSoftBytes || input.rssSoftBytes >= input.rssHardBytes) {
      throw new RangeError("Resource gate thresholds must satisfy resume < soft < hard.");
    }
    const sampledAt = finiteTimestamp(input.sampledAt ?? this.#clock());
    return this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO resource_gate
            (profile_id, generation, phase, reason, process_tree_rss_bytes,
             rss_soft_bytes, rss_hard_bytes, rss_resume_bytes, sampled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(profile_id) DO UPDATE SET
             generation = excluded.generation, phase = excluded.phase, reason = excluded.reason,
             process_tree_rss_bytes = excluded.process_tree_rss_bytes,
             rss_soft_bytes = excluded.rss_soft_bytes, rss_hard_bytes = excluded.rss_hard_bytes,
             rss_resume_bytes = excluded.rss_resume_bytes, sampled_at = excluded.sampled_at`,
        )
        .run(
          this.profileId,
          input.generation ?? null,
          input.phase,
          input.reason,
          input.processTreeRssBytes ?? null,
          input.rssSoftBytes,
          input.rssHardBytes,
          input.rssResumeBytes,
          sampledAt,
        );
      return this.#readResourceGateOrThrow();
    });
  }

  getResourceGate(): BrowserCoordinatorResourceGate | null {
    this.#assertOpen();
    return this.#readResourceGate();
  }

  #initializeSchema(): void {
    const version = Number(
      (this.#db.prepare("PRAGMA user_version").get() as { user_version?: unknown })?.user_version ??
        0,
    );
    if (version > COORDINATOR_SCHEMA_VERSION) {
      throw new Error(
        `Coordinator database schema ${version} is newer than supported version ${COORDINATOR_SCHEMA_VERSION}.`,
      );
    }
    if (version === 0) {
      const existingTables = this.#db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((row) => String((row as { name: unknown }).name));
      if (existingTables.length > 0) {
        throw new Error("Coordinator database has an incomplete or unsupported schema.");
      }
      this.#transaction(() => {
        this.#db.exec(`
          CREATE TABLE schema_meta (
            version INTEGER PRIMARY KEY,
            initialized_at INTEGER NOT NULL
          );
          CREATE TABLE profiles (
            profile_id TEXT PRIMARY KEY,
            path TEXT,
            generation INTEGER NOT NULL CHECK (generation > 0),
            owner_pid INTEGER,
            owner_start_token TEXT,
            browser_pid INTEGER,
            devtools_endpoint TEXT,
            state TEXT NOT NULL CHECK (state IN ('running', 'stopped')),
            heartbeat_at INTEGER
          );
          CREATE TABLE targets (
            target_id TEXT PRIMARY KEY,
            reservation_id TEXT NOT NULL UNIQUE,
            profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
            generation INTEGER NOT NULL CHECK (generation > 0),
            role TEXT NOT NULL,
            owner_job_id TEXT,
            state TEXT NOT NULL CHECK (state IN ('admitted', 'active', 'closing', 'closed', 'lost')),
            url TEXT,
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL
          );
          CREATE INDEX targets_profile_active_idx
            ON targets(profile_id, generation, state, role);
          CREATE TABLE jobs (
            job_id TEXT PRIMARY KEY,
            profile_id TEXT REFERENCES profiles(profile_id) ON DELETE SET NULL,
            operation TEXT NOT NULL,
            state TEXT NOT NULL,
            reason_code TEXT,
            request_hash TEXT,
            conversation_id TEXT,
            expected_head TEXT,
            owner_generation INTEGER,
            owner_lease_id TEXT,
            idempotency_key TEXT,
            attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            retry_policy TEXT
          );
          CREATE INDEX jobs_profile_state_idx ON jobs(profile_id, state, updated_at);
          CREATE UNIQUE INDEX jobs_profile_idempotency_idx
            ON jobs(profile_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
          CREATE TABLE job_events (
            job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL CHECK (sequence > 0),
            state TEXT NOT NULL,
            reason_code TEXT,
            evidence_path TEXT,
            timestamp INTEGER NOT NULL,
            PRIMARY KEY (job_id, sequence)
          );
          CREATE TABLE attachments (
            attachment_id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
            path TEXT NOT NULL,
            size INTEGER NOT NULL CHECK (size >= 0),
            media_type TEXT,
            sha256 TEXT,
            remote_file_id TEXT,
            observed_state TEXT
          );
          CREATE TABLE artifacts (
            artifact_id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            source_url TEXT,
            path TEXT,
            size INTEGER CHECK (size IS NULL OR size >= 0),
            sha256 TEXT,
            turn_id TEXT
          );
          CREATE TABLE rate_limits (
            profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            limit_value REAL,
            remaining REAL,
            reset_at INTEGER,
            retry_after REAL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (profile_id, key)
          );
          CREATE TABLE resource_samples (
            sample_id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
            generation INTEGER,
            sampled_at INTEGER NOT NULL,
            process_tree_rss_bytes INTEGER NOT NULL CHECK (process_tree_rss_bytes >= 0),
            process_tree_cpu_time_ms REAL,
            chrome_pid INTEGER,
            process_count INTEGER
          );
          CREATE INDEX resource_samples_profile_idx
            ON resource_samples(profile_id, sampled_at DESC, sample_id DESC);
          CREATE TABLE resource_gate (
            profile_id TEXT PRIMARY KEY REFERENCES profiles(profile_id) ON DELETE CASCADE,
            generation INTEGER,
            phase TEXT NOT NULL CHECK (phase IN ('normal', 'soft', 'hard', 'unknown')),
            reason TEXT NOT NULL,
            process_tree_rss_bytes INTEGER,
            rss_soft_bytes INTEGER NOT NULL CHECK (rss_soft_bytes > 0),
            rss_hard_bytes INTEGER NOT NULL CHECK (rss_hard_bytes > 0),
            rss_resume_bytes INTEGER NOT NULL CHECK (rss_resume_bytes > 0),
            sampled_at INTEGER NOT NULL
          );
          INSERT INTO schema_meta(version, initialized_at) VALUES (2, ${Math.trunc(this.#clock())});
          PRAGMA user_version = 2;
        `);
      });
      return;
    }
    if (version === 1) {
      this.#transaction(() => {
        this.#db.exec(`
          CREATE TABLE resource_gate (
            profile_id TEXT PRIMARY KEY REFERENCES profiles(profile_id) ON DELETE CASCADE,
            generation INTEGER,
            phase TEXT NOT NULL CHECK (phase IN ('normal', 'soft', 'hard', 'unknown')),
            reason TEXT NOT NULL,
            process_tree_rss_bytes INTEGER,
            rss_soft_bytes INTEGER NOT NULL CHECK (rss_soft_bytes > 0),
            rss_hard_bytes INTEGER NOT NULL CHECK (rss_hard_bytes > 0),
            rss_resume_bytes INTEGER NOT NULL CHECK (rss_resume_bytes > 0),
            sampled_at INTEGER NOT NULL
          );
          UPDATE schema_meta SET version = 2;
          PRAGMA user_version = 2;
        `);
      });
    }
    this.#validateSchema();
  }

  #validateSchema(): void {
    const required = [
      "schema_meta",
      "profiles",
      "targets",
      "jobs",
      "job_events",
      "attachments",
      "artifacts",
      "rate_limits",
      "resource_samples",
      "resource_gate",
    ];
    const rows = this.#db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String((row as { name: unknown }).name));
    for (const name of required) {
      if (!rows.includes(name)) throw new Error(`Coordinator database is missing table ${name}.`);
    }
    const schemaVersion = Number(
      (
        this.#db.prepare("SELECT MAX(version) AS version FROM schema_meta").get() as {
          version?: unknown;
        }
      )?.version ?? 0,
    );
    if (schemaVersion !== COORDINATOR_SCHEMA_VERSION) {
      throw new Error(`Coordinator database metadata version ${schemaVersion} is unsupported.`);
    }
  }

  #transaction<T>(callback: () => T): T {
    this.#assertOpen();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }

  #insertEvent(
    jobId: string,
    state: BrowserCoordinatorJobState,
    reasonCode: string | null,
    evidencePath: string | null,
    timestamp: number,
  ): BrowserCoordinatorJobEvent {
    const previous = this.#db
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence, COALESCE(MAX(timestamp), 0) AS timestamp FROM job_events WHERE job_id = ?",
      )
      .get(jobId) as { sequence?: unknown; timestamp?: unknown } | undefined;
    const sequence = Number(previous?.sequence ?? 0) + 1;
    const monotonicTimestamp = Math.max(timestamp, Number(previous?.timestamp ?? 0));
    this.#db
      .prepare(
        `INSERT INTO job_events (job_id, sequence, state, reason_code, evidence_path, timestamp)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(jobId, sequence, state, reasonCode, evidencePath, monotonicTimestamp);
    return {
      jobId,
      sequence,
      state,
      reasonCode,
      evidencePath,
      timestamp: monotonicTimestamp,
    };
  }

  #countActiveTargets(role: BrowserCoordinatorTargetRole | undefined, generation: number): number {
    const query = role
      ? "SELECT COUNT(*) AS count FROM targets WHERE profile_id = ? AND generation = ? AND role = ? AND state IN ('admitted', 'active', 'closing')"
      : "SELECT COUNT(*) AS count FROM targets WHERE profile_id = ? AND generation = ? AND state IN ('admitted', 'active', 'closing')";
    const row = role
      ? this.#db.prepare(query).get(this.profileId, generation, role)
      : this.#db.prepare(query).get(this.profileId, generation);
    return Number((row as { count?: unknown } | undefined)?.count ?? 0);
  }

  #totalCeiling(): number {
    return this.#targetCeilings.total ?? DEFAULT_COORDINATOR_TARGET_CEILING;
  }

  #roleCeiling(role: BrowserCoordinatorTargetRole): number | null {
    const value = this.#targetCeilings.roles?.[role] ?? this.#targetCeilings[role];
    return typeof value === "number" ? value : null;
  }

  #claimResult(
    reason: ProfileGenerationClaimReason,
    takeover: boolean,
    profile: BrowserCoordinatorProfile,
  ): BrowserCoordinatorGenerationClaim {
    return {
      claimed: reason === "claimed" || reason === "already_owner",
      generation: profile.generation,
      takeover,
      reason,
      profile,
    };
  }

  #profilePath(): string | null {
    return this.#profilePathValue;
  }

  #readProfile(): BrowserCoordinatorProfile | null {
    const row = this.#db
      .prepare(
        `SELECT profile_id, path, generation, owner_pid, owner_start_token, browser_pid,
                devtools_endpoint, state, heartbeat_at
         FROM profiles WHERE profile_id = ?`,
      )
      .get(this.profileId);
    return row ? profileFromRow(row) : null;
  }

  #readProfileOrThrow(): BrowserCoordinatorProfile {
    const profile = this.#readProfile();
    if (!profile) throw new Error(`Coordinator profile ${this.profileId} is not initialized.`);
    return profile;
  }

  #readTarget(targetId: string): BrowserCoordinatorTarget | null {
    const row = this.#db
      .prepare(
        `SELECT target_id, reservation_id, profile_id, generation, role, owner_job_id, state, url, created_at, last_seen_at
         FROM targets WHERE target_id = ?`,
      )
      .get(targetId);
    return row ? targetFromRow(row) : null;
  }

  #readJob(jobId: string): BrowserCoordinatorJob | null {
    const row = this.#db
      .prepare(
        `SELECT job_id, profile_id, operation, state, reason_code, request_hash, conversation_id,
                expected_head, owner_generation, owner_lease_id, idempotency_key, attempt,
                created_at, updated_at, retry_policy
         FROM jobs WHERE job_id = ?`,
      )
      .get(jobId);
    return row ? jobFromRow(row) : null;
  }

  #readJobOrThrow(jobId: string): BrowserCoordinatorJob {
    const job = this.#readJob(jobId);
    if (!job) throw new Error(`Coordinator job ${jobId} was not found.`);
    return job;
  }

  #readAttachmentOrThrow(attachmentId: string): BrowserCoordinatorAttachment {
    const row = this.#db
      .prepare(
        `SELECT attachment_id, job_id, path, size, media_type, sha256, remote_file_id, observed_state
         FROM attachments WHERE attachment_id = ?`,
      )
      .get(attachmentId);
    if (!row) throw new Error(`Coordinator attachment ${attachmentId} was not created.`);
    return attachmentFromRow(row);
  }

  #readArtifactOrThrow(artifactId: string): BrowserCoordinatorArtifact {
    const row = this.#db
      .prepare(
        `SELECT artifact_id, job_id, kind, source_url, path, size, sha256, turn_id
         FROM artifacts WHERE artifact_id = ?`,
      )
      .get(artifactId);
    if (!row) throw new Error(`Coordinator artifact ${artifactId} was not created.`);
    return artifactFromRow(row);
  }

  #readRateLimitOrThrow(key: string): BrowserCoordinatorRateLimit {
    const row = this.#db
      .prepare(
        `SELECT key, limit_value, remaining, reset_at, retry_after, updated_at
         FROM rate_limits WHERE profile_id = ? AND key = ?`,
      )
      .get(this.profileId, key);
    if (!row) throw new Error(`Coordinator rate-limit row ${key} was not created.`);
    return rateLimitFromRow(row);
  }

  #readResourceSampleOrThrow(sampleId: number): BrowserCoordinatorResourceSample {
    const row = this.#db
      .prepare(
        `SELECT sample_id, profile_id, generation, sampled_at, process_tree_rss_bytes,
                process_tree_cpu_time_ms, chrome_pid, process_count
         FROM resource_samples WHERE sample_id = ?`,
      )
      .get(sampleId);
    if (!row) throw new Error(`Coordinator resource sample ${sampleId} was not created.`);
    return resourceSampleFromRow(row);
  }

  #readResourceGate(): BrowserCoordinatorResourceGate | null {
    const row = this.#db
      .prepare(
        `SELECT profile_id, generation, phase, reason, process_tree_rss_bytes,
                rss_soft_bytes, rss_hard_bytes, rss_resume_bytes, sampled_at
         FROM resource_gate WHERE profile_id = ?`,
      )
      .get(this.profileId);
    return row ? resourceGateFromRow(row) : null;
  }

  #readResourceGateOrThrow(): BrowserCoordinatorResourceGate {
    const gate = this.#readResourceGate();
    if (!gate) throw new Error(`Coordinator resource gate ${this.profileId} was not created.`);
    return gate;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("BrowserCoordinatorStore is closed.");
  }
}

export function openBrowserCoordinatorStore(
  options: BrowserCoordinatorStoreOptions,
): BrowserCoordinatorStore {
  return new BrowserCoordinatorStore(options);
}

function normalizeTargetCeilings(
  ceilings: BrowserCoordinatorTargetCeilings | undefined,
): BrowserCoordinatorTargetCeilings {
  const normalized: BrowserCoordinatorTargetCeilings = { roles: {} };
  if (!ceilings) return normalized;
  const total = ceilings.total;
  if (total !== undefined) normalized.total = positiveInteger(total, "targetCeilings.total");
  for (const [role, value] of Object.entries(ceilings)) {
    if (role === "total" || role === "roles") continue;
    if (typeof value === "number")
      (normalized.roles as Record<string, number>)[role] = positiveInteger(
        value,
        `target ceiling ${role}`,
      );
  }
  if (ceilings.roles) {
    for (const [role, value] of Object.entries(ceilings.roles)) {
      if (value !== undefined)
        (normalized.roles as Record<string, number>)[role] = positiveInteger(
          value,
          `target ceiling ${role}`,
        );
    }
  }
  return normalized;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

function finiteTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error("Timestamp must be a non-negative finite number.");
  return Math.trunc(value);
}

function validateSize(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative safe integer.`);
}

function validateAttempt(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("attempt must be a non-negative safe integer.");
  }
}

function validateGeneration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function assertOwner(ownerPid: number, ownerStartToken: string): void {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0)
    throw new Error("ownerPid must be a positive safe integer.");
  validateMetadata(ownerStartToken, "ownerStartToken");
}

function validateMetadata(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty.`);
  validateOptionalMetadata(value, name);
}

function validateOptionalMetadata(value: string | null | undefined, name: string): void {
  if (
    value !== null &&
    value !== undefined &&
    Buffer.byteLength(value, "utf8") > MAX_COORDINATOR_METADATA_TEXT_BYTES
  ) {
    throw new Error(`${name} exceeds the coordinator metadata limit.`);
  }
}

function validateTargetInput(
  targetId: string,
  role: BrowserCoordinatorTargetRole,
  state: BrowserCoordinatorTargetState,
  url: string | null | undefined,
): void {
  validateMetadata(targetId, "targetId");
  validateMetadata(role, "role");
  if (
    !ACTIVE_TARGET_STATES.includes(state as (typeof ACTIVE_TARGET_STATES)[number]) &&
    state !== "closed" &&
    state !== "lost"
  ) {
    throw new Error(`Unknown target state ${state}.`);
  }
  validateOptionalMetadata(url, "url");
}

function profileFromRow(row: Record<string, unknown>): BrowserCoordinatorProfile {
  return {
    profileId: String(row.profile_id),
    path: nullableString(row.path),
    generation: Number(row.generation),
    ownerPid: nullableNumber(row.owner_pid),
    ownerStartToken: nullableString(row.owner_start_token),
    browserPid: nullableNumber(row.browser_pid),
    devtoolsEndpoint: nullableString(row.devtools_endpoint),
    state: String(row.state) as BrowserCoordinatorProfileState,
    heartbeatAt: nullableNumber(row.heartbeat_at),
  };
}

function targetFromRow(row: Record<string, unknown>): BrowserCoordinatorTarget {
  return {
    targetId: String(row.target_id),
    reservationId: String(row.reservation_id),
    profileId: String(row.profile_id),
    generation: Number(row.generation),
    role: String(row.role) as BrowserCoordinatorTargetRole,
    ownerJobId: nullableString(row.owner_job_id),
    state: String(row.state) as BrowserCoordinatorTargetState,
    url: nullableString(row.url),
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
  };
}

function jobFromRow(row: Record<string, unknown>): BrowserCoordinatorJob {
  return {
    jobId: String(row.job_id),
    profileId: nullableString(row.profile_id),
    operation: String(row.operation),
    state: String(row.state) as BrowserCoordinatorJobState,
    reasonCode: nullableString(row.reason_code),
    requestHash: nullableString(row.request_hash),
    conversationId: nullableString(row.conversation_id),
    expectedHead: nullableString(row.expected_head),
    ownerGeneration: nullableNumber(row.owner_generation),
    ownerLeaseId: nullableString(row.owner_lease_id),
    idempotencyKey: nullableString(row.idempotency_key),
    attempt: Number(row.attempt),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    retryPolicy: nullableString(row.retry_policy),
  };
}

function eventFromRow(row: Record<string, unknown>): BrowserCoordinatorJobEvent {
  return {
    jobId: String(row.job_id),
    sequence: Number(row.sequence),
    state: String(row.state),
    reasonCode: nullableString(row.reason_code),
    evidencePath: nullableString(row.evidence_path),
    timestamp: Number(row.timestamp),
  };
}

function attachmentFromRow(row: Record<string, unknown>): BrowserCoordinatorAttachment {
  return {
    attachmentId: String(row.attachment_id),
    jobId: String(row.job_id),
    path: String(row.path),
    size: Number(row.size),
    mediaType: nullableString(row.media_type),
    sha256: nullableString(row.sha256),
    remoteFileId: nullableString(row.remote_file_id),
    observedState: nullableString(row.observed_state),
  };
}

function artifactFromRow(row: Record<string, unknown>): BrowserCoordinatorArtifact {
  return {
    artifactId: String(row.artifact_id),
    jobId: String(row.job_id),
    kind: String(row.kind),
    sourceUrl: nullableString(row.source_url),
    path: nullableString(row.path),
    size: nullableNumber(row.size),
    sha256: nullableString(row.sha256),
    turnId: nullableString(row.turn_id),
  };
}

function rateLimitFromRow(row: Record<string, unknown>): BrowserCoordinatorRateLimit {
  return {
    key: String(row.key),
    limit: nullableNumber(row.limit_value),
    remaining: nullableNumber(row.remaining),
    resetAt: nullableNumber(row.reset_at),
    retryAfter: nullableNumber(row.retry_after),
    updatedAt: Number(row.updated_at),
  };
}

function resourceSampleFromRow(row: Record<string, unknown>): BrowserCoordinatorResourceSample {
  return {
    sampleId: Number(row.sample_id),
    profileId: String(row.profile_id),
    generation: nullableNumber(row.generation),
    sampledAt: Number(row.sampled_at),
    processTreeRssBytes: Number(row.process_tree_rss_bytes),
    processTreeCpuTimeMs: nullableNumber(row.process_tree_cpu_time_ms),
    chromePid: nullableNumber(row.chrome_pid),
    processCount: nullableNumber(row.process_count),
  };
}

function resourceGateFromRow(row: Record<string, unknown>): BrowserCoordinatorResourceGate {
  return {
    profileId: String(row.profile_id),
    generation: nullableNumber(row.generation),
    phase: String(row.phase) as BrowserCoordinatorResourceGatePhase,
    reason: String(row.reason),
    processTreeRssBytes: nullableNumber(row.process_tree_rss_bytes),
    rssSoftBytes: Number(row.rss_soft_bytes),
    rssHardBytes: Number(row.rss_hard_bytes),
    rssResumeBytes: Number(row.rss_resume_bytes),
    sampledAt: Number(row.sampled_at),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
