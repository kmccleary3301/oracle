import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import {
  DEFAULT_COORDINATOR_BUSY_TIMEOUT_MS,
  DEFAULT_COORDINATOR_MAX_RESOURCE_SAMPLES,
  DEFAULT_COORDINATOR_STALE_OWNER_MS,
  DEFAULT_COORDINATOR_TARGET_CEILING,
  defaultCoordinatorDatabasePath,
  defaultCoordinatorProfilePath,
  type AddArtifactInput,
  type AddAttachmentInput,
  type AdmitTargetInput,
  type AppendJobEventInput,
  type AppendResourceSampleInput,
  type BindTargetReservationInput,
  type BrowserCoordinatorArtifact,
  type BrowserCoordinatorAttachment,
  type BrowserCoordinatorGenerationClaim,
  type BrowserCoordinatorJob,
  type BrowserCoordinatorJobEvent,
  type BrowserCoordinatorProfile,
  type BrowserCoordinatorRateLimit,
  type BrowserCoordinatorResourceGate,
  type BrowserCoordinatorResourceSample,
  type BrowserCoordinatorStoreOptions,
  type BrowserCoordinatorTarget,
  type BrowserCoordinatorTargetAdmission,
  type BrowserCoordinatorTargetBinding,
  type BrowserCoordinatorTargetCeilings,
  type BrowserCoordinatorTargetRole,
  type ClaimProfileGenerationInput,
  type CreateJobInput,
  type HeartbeatProfileInput,
  type ProfileGenerationClaimReason,
  type TargetAdmissionReason,
  type TransitionJobInput,
  type UpdateTargetInput,
  type UpsertRateLimitInput,
  type UpsertResourceGateInput,
} from "./coordinatorTypes.js";
import { initializeCoordinatorSchema } from "./coordinatorSchema.js";
import {
  artifactFromRow,
  assertOwner,
  countActiveCoordinatorTargets,
  insertCoordinatorJobEvent,
  attachmentFromRow,
  eventFromRow,
  finiteTimestamp,
  jobFromRow,
  normalizeTargetCeilings,
  positiveInteger,
  rateLimitFromRow,
  readCoordinatorJob,
  readCoordinatorProfile,
  readCoordinatorResourceGate,
  readCoordinatorTarget,
  requireCoordinatorArtifact,
  requireCoordinatorAttachment,
  requireCoordinatorJob,
  requireCoordinatorProfile,
  requireCoordinatorRateLimit,
  requireCoordinatorResourceGate,
  requireCoordinatorResourceSample,
  resourceSampleFromRow,
  targetFromRow,
  validateAttempt,
  validateGeneration,
  validateMetadata,
  validateOptionalMetadata,
  validateSize,
  validateTargetInput,
} from "./coordinatorValidation.js";

export * from "./coordinatorTypes.js";

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
      initializeCoordinatorSchema(this.#db, this.#clock(), (callback) =>
        this.#transaction(callback),
      );
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
    return readCoordinatorProfile(this.#db, this.profileId);
  }

  claimProfileGeneration(input: ClaimProfileGenerationInput): BrowserCoordinatorGenerationClaim {
    this.#assertOpen();
    assertOwner(input.ownerPid, input.ownerStartToken);
    const now = finiteTimestamp(input.now ?? this.#clock());
    const staleOwnerMs = positiveInteger(input.staleOwnerMs ?? this.#staleOwnerMs, "staleOwnerMs");
    return this.#transaction(() => {
      const existing = readCoordinatorProfile(this.#db, this.profileId);
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
        return this.#claimResult(
          "claimed",
          false,
          requireCoordinatorProfile(this.#db, this.profileId),
        );
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
        return this.#claimResult(
          "claimed",
          true,
          requireCoordinatorProfile(this.#db, this.profileId),
        );
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
        return this.#claimResult(
          "already_owner",
          false,
          requireCoordinatorProfile(this.#db, this.profileId),
        );
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
      return this.#claimResult(
        "claimed",
        true,
        requireCoordinatorProfile(this.#db, this.profileId),
      );
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
      const profile = requireCoordinatorProfile(this.#db, this.profileId);
      if (profile.generation !== input.generation) {
        return {
          admitted: false,
          reason: "generation_mismatch",
          reservationId,
          target: null,
          activeTargetCount: countActiveCoordinatorTargets(
            this.#db,
            this.profileId,
            undefined,
            profile.generation,
          ),
          activeRoleCount: countActiveCoordinatorTargets(
            this.#db,
            this.profileId,
            input.role,
            profile.generation,
          ),
        };
      }
      const resourceGate = readCoordinatorResourceGate(this.#db, this.profileId);
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
          activeTargetCount: countActiveCoordinatorTargets(
            this.#db,
            this.profileId,
            undefined,
            profile.generation,
          ),
          activeRoleCount: countActiveCoordinatorTargets(
            this.#db,
            this.profileId,
            input.role,
            profile.generation,
          ),
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
          activeTargetCount: countActiveCoordinatorTargets(
            this.#db,
            this.profileId,
            undefined,
            profile.generation,
          ),
          activeRoleCount: countActiveCoordinatorTargets(
            this.#db,
            this.profileId,
            input.role,
            profile.generation,
          ),
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
          activeTargetCount: countActiveCoordinatorTargets(
            this.#db,
            this.profileId,
            undefined,
            profile.generation,
          ),
          activeRoleCount: countActiveCoordinatorTargets(
            this.#db,
            this.profileId,
            input.role,
            profile.generation,
          ),
        };
      }
      const activeTargetCount = countActiveCoordinatorTargets(
        this.#db,
        this.profileId,
        undefined,
        profile.generation,
      );
      const activeRoleCount = countActiveCoordinatorTargets(
        this.#db,
        this.profileId,
        input.role,
        profile.generation,
      );
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
      const target = readCoordinatorTarget(this.#db, targetId);
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
          target: readCoordinatorTarget(this.#db, currentTargetId),
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
        target: readCoordinatorTarget(this.#db, input.targetId),
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
      return Number(result.changes) === 1 ? readCoordinatorTarget(this.#db, input.targetId) : null;
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
      insertCoordinatorJobEvent(this.#db, jobId, state, input.reasonCode ?? null, null, now);
      return requireCoordinatorJob(this.#db, jobId);
    });
  }

  getJob(jobId: string): BrowserCoordinatorJob | null {
    this.#assertOpen();
    return readCoordinatorJob(this.#db, jobId);
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
      const current = readCoordinatorJob(this.#db, input.jobId);
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
      insertCoordinatorJobEvent(
        this.#db,
        input.jobId,
        input.nextState,
        input.reasonCode !== undefined ? input.reasonCode : current.reasonCode,
        input.evidencePath ?? null,
        Math.max(now, current.updatedAt),
      );
      return requireCoordinatorJob(this.#db, input.jobId);
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
      insertCoordinatorJobEvent(
        this.#db,
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
      return requireCoordinatorAttachment(this.#db, attachmentId);
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
      return requireCoordinatorArtifact(this.#db, artifactId);
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
      return requireCoordinatorRateLimit(this.#db, this.profileId, input.key);
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
      return requireCoordinatorResourceSample(this.#db, sampleId);
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
      return requireCoordinatorResourceGate(this.#db, this.profileId);
    });
  }

  getResourceGate(): BrowserCoordinatorResourceGate | null {
    this.#assertOpen();
    return readCoordinatorResourceGate(this.#db, this.profileId);
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

  #assertOpen(): void {
    if (this.#closed) throw new Error("BrowserCoordinatorStore is closed.");
  }
}

export function openBrowserCoordinatorStore(
  options: BrowserCoordinatorStoreOptions,
): BrowserCoordinatorStore {
  return new BrowserCoordinatorStore(options);
}
