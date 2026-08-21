import { createHash } from "node:crypto";
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
