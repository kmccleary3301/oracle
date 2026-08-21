import type { DatabaseSync } from "node:sqlite";
import {
  MAX_COORDINATOR_METADATA_TEXT_BYTES,
  type BrowserCoordinatorArtifact,
  type BrowserCoordinatorAttachment,
  type BrowserCoordinatorJob,
  type BrowserCoordinatorJobEvent,
  type BrowserCoordinatorJobState,
  type BrowserCoordinatorProfile,
  type BrowserCoordinatorProfileState,
  type BrowserCoordinatorRateLimit,
  type BrowserCoordinatorResourceGate,
  type BrowserCoordinatorResourceGatePhase,
  type BrowserCoordinatorResourceSample,
  type BrowserCoordinatorTarget,
  type BrowserCoordinatorTargetCeilings,
  type BrowserCoordinatorTargetRole,
  type BrowserCoordinatorTargetState,
} from "./coordinatorTypes.js";

export const ACTIVE_TARGET_STATES = ["admitted", "active", "closing"] as const;

export function normalizeTargetCeilings(
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

export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

export function finiteTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error("Timestamp must be a non-negative finite number.");
  return Math.trunc(value);
}

export function validateSize(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative safe integer.`);
}

export function validateAttempt(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("attempt must be a non-negative safe integer.");
  }
}

export function validateGeneration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

export function assertOwner(ownerPid: number, ownerStartToken: string): void {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0)
    throw new Error("ownerPid must be a positive safe integer.");
  validateMetadata(ownerStartToken, "ownerStartToken");
}

export function validateMetadata(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty.`);
  validateOptionalMetadata(value, name);
}

export function validateOptionalMetadata(value: string | null | undefined, name: string): void {
  if (
    value !== null &&
    value !== undefined &&
    Buffer.byteLength(value, "utf8") > MAX_COORDINATOR_METADATA_TEXT_BYTES
  ) {
    throw new Error(`${name} exceeds the coordinator metadata limit.`);
  }
}

export function validateTargetInput(
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

export function profileFromRow(row: Record<string, unknown>): BrowserCoordinatorProfile {
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

export function targetFromRow(row: Record<string, unknown>): BrowserCoordinatorTarget {
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

export function jobFromRow(row: Record<string, unknown>): BrowserCoordinatorJob {
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

export function eventFromRow(row: Record<string, unknown>): BrowserCoordinatorJobEvent {
  return {
    jobId: String(row.job_id),
    sequence: Number(row.sequence),
    state: String(row.state),
    reasonCode: nullableString(row.reason_code),
    evidencePath: nullableString(row.evidence_path),
    timestamp: Number(row.timestamp),
  };
}

export function attachmentFromRow(row: Record<string, unknown>): BrowserCoordinatorAttachment {
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

export function artifactFromRow(row: Record<string, unknown>): BrowserCoordinatorArtifact {
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

export function rateLimitFromRow(row: Record<string, unknown>): BrowserCoordinatorRateLimit {
  return {
    key: String(row.key),
    limit: nullableNumber(row.limit_value),
    remaining: nullableNumber(row.remaining),
    resetAt: nullableNumber(row.reset_at),
    retryAfter: nullableNumber(row.retry_after),
    updatedAt: Number(row.updated_at),
  };
}

export function resourceSampleFromRow(
  row: Record<string, unknown>,
): BrowserCoordinatorResourceSample {
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

export function resourceGateFromRow(row: Record<string, unknown>): BrowserCoordinatorResourceGate {
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

export function readCoordinatorProfile(
  db: DatabaseSync,
  profileId: string,
): BrowserCoordinatorProfile | null {
  const row = db
    .prepare(
      `SELECT profile_id, path, generation, owner_pid, owner_start_token, browser_pid,
              devtools_endpoint, state, heartbeat_at
       FROM profiles WHERE profile_id = ?`,
    )
    .get(profileId);
  return row ? profileFromRow(row as Record<string, unknown>) : null;
}

export function requireCoordinatorProfile(
  db: DatabaseSync,
  profileId: string,
): BrowserCoordinatorProfile {
  const profile = readCoordinatorProfile(db, profileId);
  if (!profile) throw new Error(`Coordinator profile ${profileId} is not initialized.`);
  return profile;
}

export function readCoordinatorTarget(
  db: DatabaseSync,
  targetId: string,
): BrowserCoordinatorTarget | null {
  const row = db
    .prepare(
      `SELECT target_id, reservation_id, profile_id, generation, role, owner_job_id, state, url, created_at, last_seen_at
       FROM targets WHERE target_id = ?`,
    )
    .get(targetId);
  return row ? targetFromRow(row as Record<string, unknown>) : null;
}

export function readCoordinatorJob(db: DatabaseSync, jobId: string): BrowserCoordinatorJob | null {
  const row = db
    .prepare(
      `SELECT job_id, profile_id, operation, state, reason_code, request_hash, conversation_id,
              expected_head, owner_generation, owner_lease_id, idempotency_key, attempt,
              created_at, updated_at, retry_policy
       FROM jobs WHERE job_id = ?`,
    )
    .get(jobId);
  return row ? jobFromRow(row as Record<string, unknown>) : null;
}

export function requireCoordinatorJob(db: DatabaseSync, jobId: string): BrowserCoordinatorJob {
  const job = readCoordinatorJob(db, jobId);
  if (!job) throw new Error(`Coordinator job ${jobId} was not found.`);
  return job;
}

export function requireCoordinatorAttachment(
  db: DatabaseSync,
  attachmentId: string,
): BrowserCoordinatorAttachment {
  const row = db
    .prepare(
      `SELECT attachment_id, job_id, path, size, media_type, sha256, remote_file_id, observed_state
       FROM attachments WHERE attachment_id = ?`,
    )
    .get(attachmentId);
  if (!row) throw new Error(`Coordinator attachment ${attachmentId} was not created.`);
  return attachmentFromRow(row as Record<string, unknown>);
}

export function requireCoordinatorArtifact(
  db: DatabaseSync,
  artifactId: string,
): BrowserCoordinatorArtifact {
  const row = db
    .prepare(
      `SELECT artifact_id, job_id, kind, source_url, path, size, sha256, turn_id
       FROM artifacts WHERE artifact_id = ?`,
    )
    .get(artifactId);
  if (!row) throw new Error(`Coordinator artifact ${artifactId} was not created.`);
  return artifactFromRow(row as Record<string, unknown>);
}

export function requireCoordinatorRateLimit(
  db: DatabaseSync,
  profileId: string,
  key: string,
): BrowserCoordinatorRateLimit {
  const row = db
    .prepare(
      `SELECT key, limit_value, remaining, reset_at, retry_after, updated_at
       FROM rate_limits WHERE profile_id = ? AND key = ?`,
    )
    .get(profileId, key);
  if (!row) throw new Error(`Coordinator rate-limit row ${key} was not created.`);
  return rateLimitFromRow(row as Record<string, unknown>);
}

export function requireCoordinatorResourceSample(
  db: DatabaseSync,
  sampleId: number,
): BrowserCoordinatorResourceSample {
  const row = db
    .prepare(
      `SELECT sample_id, profile_id, generation, sampled_at, process_tree_rss_bytes,
              process_tree_cpu_time_ms, chrome_pid, process_count
       FROM resource_samples WHERE sample_id = ?`,
    )
    .get(sampleId);
  if (!row) throw new Error(`Coordinator resource sample ${sampleId} was not created.`);
  return resourceSampleFromRow(row as Record<string, unknown>);
}

export function readCoordinatorResourceGate(
  db: DatabaseSync,
  profileId: string,
): BrowserCoordinatorResourceGate | null {
  const row = db
    .prepare(
      `SELECT profile_id, generation, phase, reason, process_tree_rss_bytes,
              rss_soft_bytes, rss_hard_bytes, rss_resume_bytes, sampled_at
       FROM resource_gate WHERE profile_id = ?`,
    )
    .get(profileId);
  return row ? resourceGateFromRow(row as Record<string, unknown>) : null;
}

export function requireCoordinatorResourceGate(
  db: DatabaseSync,
  profileId: string,
): BrowserCoordinatorResourceGate {
  const gate = readCoordinatorResourceGate(db, profileId);
  if (!gate) throw new Error(`Coordinator resource gate ${profileId} was not created.`);
  return gate;
}

export function insertCoordinatorJobEvent(
  db: DatabaseSync,
  jobId: string,
  state: BrowserCoordinatorJobState,
  reasonCode: string | null,
  evidencePath: string | null,
  timestamp: number,
): BrowserCoordinatorJobEvent {
  const previous = db
    .prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence, COALESCE(MAX(timestamp), 0) AS timestamp FROM job_events WHERE job_id = ?",
    )
    .get(jobId) as { sequence?: unknown; timestamp?: unknown } | undefined;
  const sequence = Number(previous?.sequence ?? 0) + 1;
  const monotonicTimestamp = Math.max(timestamp, Number(previous?.timestamp ?? 0));
  db.prepare(
    `INSERT INTO job_events (job_id, sequence, state, reason_code, evidence_path, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(jobId, sequence, state, reasonCode, evidencePath, monotonicTimestamp);
  return {
    jobId,
    sequence,
    state,
    reasonCode,
    evidencePath,
    timestamp: monotonicTimestamp,
  };
}

export function countActiveCoordinatorTargets(
  db: DatabaseSync,
  profileId: string,
  role: BrowserCoordinatorTargetRole | undefined,
  generation: number,
): number {
  const query = role
    ? "SELECT COUNT(*) AS count FROM targets WHERE profile_id = ? AND generation = ? AND role = ? AND state IN ('admitted', 'active', 'closing')"
    : "SELECT COUNT(*) AS count FROM targets WHERE profile_id = ? AND generation = ? AND state IN ('admitted', 'active', 'closing')";
  const row = role
    ? db.prepare(query).get(profileId, generation, role)
    : db.prepare(query).get(profileId, generation);
  return Number((row as { count?: unknown } | undefined)?.count ?? 0);
}
