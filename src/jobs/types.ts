import type { BrowserResponseProvenance } from "../browser/types.js";
export const ORACLE_JOB_STATUSES = [
  "queued",
  "starting",
  "running",
  "waiting_for_model",
  "extracting_artifacts",
  "completed",
  "failed",
  "cancel_requested",
  "cancelled",
  "requires_action",
  "unknown",
  "conflict",
] as const;

export type OracleJobStatus = (typeof ORACLE_JOB_STATUSES)[number];

export const ORACLE_JOB_OUTCOMES = [
  "success",
  "failure",
  "cancelled",
  "unknown",
  "conflict",
  "requires_action",
] as const;

export type OracleJobOutcome = (typeof ORACLE_JOB_OUTCOMES)[number];

export const ORACLE_JOB_SUBMISSION_STATES = [
  "pre_submit",
  "submitting",
  "accepted",
  "submitted",
  "submission_unknown",
] as const;

export type OracleJobSubmissionState = (typeof ORACLE_JOB_SUBMISSION_STATES)[number];

export const ORACLE_JOB_PHASES = [
  "accepted",
  "queued",
  "launching_browser",
  "checking_login",
  "selecting_model",
  "setting_thinking_time",
  "uploading_attachments",
  "submitting_prompt",
  "waiting_for_response",
  "extracting_images",
  "extracting_sandbox_artifacts",
  "closing_tabs",
  "completed",
  "failed",
  "cancelled",
  "unknown",
  "conflict",
  "requires_action",
] as const;

export type OracleJobPhase = (typeof ORACLE_JOB_PHASES)[number];

export const ORACLE_JOB_KINDS = [
  "chatgpt_create_session",
  "chatgpt_send_turn",
  "chatgpt_work_start",
  "chatgpt_research_start",
  "chatgpt_research_plan",
  "chatgpt_research_get",
  "chatgpt_research_interrupt",
  "chatgpt_research_download",
  "chatgpt_generate_images",
  "chatgpt_edit_image",
  "chatgpt_extract_images",
  "chatgpt_extract_sandbox_artifacts",
  "test_sleep",
] as const;

export type OracleJobKind = (typeof ORACLE_JOB_KINDS)[number];

export const ORACLE_JOB_ACTION_REASONS = [
  "login_required",
  "otp_required",
  "cloudflare_required",
  "plan_limit",
  "modal_blocker",
  "manual_confirmation_required",
  "daemon_restarted",
  "submission_unknown",
] as const;

export type OracleJobActionReason = (typeof ORACLE_JOB_ACTION_REASONS)[number];

export interface OracleJobActionRequired {
  kind: OracleJobActionReason | (string & {});
  message: string;
  evidencePath?: string;
  details?: Record<string, unknown>;
}

export interface OracleJobOwnerLease {
  generation: number;
  leaseId: string;
  role?: "mutation" | "polling" | "recovery" | "auth";
  ownerPid?: number;
  acquiredAt: string;
  expiresAt?: string;
}

export interface OracleJobInputSummary {
  promptChars?: number;
  attachmentCount?: number;
  outputDir?: string;
  modelLabel?: string;
  thinkingTime?: string;
  projectUrl?: string;
  returnAfterSubmit?: boolean;
}

export const ORACLE_WORK_STATES = [
  "queued",
  "submitted",
  "running",
  "waiting_for_plan_approval",
  "waiting_for_user_input",
  "waiting_for_confirmation",
  "completed",
  "interrupted",
  "requires_action",
  "unsupported",
  "conflict",
] as const;

export type OracleWorkState = (typeof ORACLE_WORK_STATES)[number];
export interface OracleJobWorkRuntime {
  state: OracleWorkState;
  conversationId?: string;
  taskId?: string;
  turnId?: string;
  revisionHash?: string;
  deliverables?: Record<string, unknown> | unknown[];
  provenance?: BrowserResponseProvenance[];
}

export interface OracleJobPollState {
  /** State observed from the remote operation on the most recent poll. */
  state: string;
  /** Durable wall-clock time at which the next poll may start. */
  dueAt?: string;
  /** Number of poll attempts made for this job. */
  attempts: number;
  /** Last wall-clock time at which meaningful remote progress was observed. */
  lastProgressAt?: string;
  /** Server supplied retry delay, when the rate-limit lane reported one. */
  retryAfterMs?: number;
  /** Thinking intensity used to bias the polling cadence. */
  thinkingClass?: string;
}

export interface OracleJobRuntime {
  daemonPid?: number;
  browserProfileDir?: string;
  remoteChrome?: string;
  tabId?: string;
  conversationUrl?: string;
  conversationId?: string;
  /** Nonresident polling state; absent means the job has no poll scheduled. */
  poll?: OracleJobPollState;
  work?: OracleJobWorkRuntime;
}
export interface OracleJobResultSummary {
  answerChars?: number;
  imageArtifacts?: number;
  sandboxArtifacts?: number;
  warnings?: number;
}

export interface OracleJobError {
  message: string;
  stack?: string;
  code?: string;
  reasonCode?: string;
  retryable?: boolean;
  requiresAction?: OracleJobActionReason | string;
  actionRequired?: OracleJobActionRequired;
  evidencePath?: string;
  evidence?: Record<string, unknown>;
}

export interface OracleJobRecord {
  id: string;
  kind: OracleJobKind;
  status: OracleJobStatus;
  /** Compatibility status; terminal semantics are carried by outcome. */
  outcome?: OracleJobOutcome;
  phase: OracleJobPhase;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  queuePosition?: number;
  progress?: {
    label: string;
    percent?: number;
    heartbeatAt?: string;
  };
  inputSummary: OracleJobInputSummary;
  /** Exact UTF-8 byte length of the persisted input.json payload. */
  inputBytes: number;
  /** SHA-256 identity of the authenticated daemon principal; never a raw token. */
  principalHash?: string;
  runtime?: OracleJobRuntime;
  resultSummary?: OracleJobResultSummary;
  resultPath?: string;
  inputPath: string;
  eventLogPath: string;
  error?: OracleJobError;
  reasonCode?: string;
  actionRequired?: OracleJobActionRequired;
  debugArtifacts?: string[];
  attempt: number;
  generation: number;
  ownerGeneration?: number;
  ownerLeaseId?: string;
  ownerLease?: OracleJobOwnerLease;
  idempotencyKey?: string;
  requestHash?: string;
  conversationId?: string;
  expectedHead?: string;
  submissionState?: OracleJobSubmissionState;
  evidencePath?: string;
}

export interface OracleJobEvent {
  seq: number;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  phase: OracleJobPhase;
  message: string;
  data?: unknown;
  reasonCode?: string;
  outcome?: OracleJobOutcome;
}

export interface OracleJobEventInput {
  id: string;
  level: OracleJobEvent["level"];
  phase: OracleJobPhase;
  message: string;
  data?: unknown;
  timestamp?: string;
  reasonCode?: string;
  outcome?: OracleJobOutcome;
}

export interface OracleJobTransitionInput {
  id: string;
  expectedStatus: OracleJobStatus;
  nextStatus: OracleJobStatus;
  phase: OracleJobPhase;
  message?: string;
  expectedPhase?: OracleJobPhase;
  expectedGeneration?: number;
  generation?: number;
  expectedOwnerGeneration?: number | null;
  ownerGeneration?: number | null;
  expectedOwnerLeaseId?: string | null;
  ownerLeaseId?: string | null;
  attempt?: number;
  outcome?: OracleJobOutcome;
  reasonCode?: string;
  error?: OracleJobError;
  actionRequired?: OracleJobActionRequired;
  evidencePath?: string;
}

export interface OracleJobCreateInput {
  kind: OracleJobKind;
  input?: unknown;
  inputSummary?: OracleJobInputSummary;
  idempotencyKey?: string;
  conversationId?: string;
  expectedHead?: string;
  ownerGeneration?: number;
  ownerLeaseId?: string;
  generation?: number;
  attempt?: number;
  submissionState?: OracleJobSubmissionState;
  /** Stable SHA-256 hash of the authenticated token identity. */
  principalHash?: string;
}

export interface OracleJobStatusResponse {
  found: boolean;
  job?: OracleJobRecord & {
    resultReady: boolean;
  };
}

export interface OracleJobResultResponse {
  found: boolean;
  ready: boolean;
  job?: OracleJobRecord;
  result?: unknown;
}

export function isOracleJobKind(value: string): value is OracleJobKind {
  return (ORACLE_JOB_KINDS as readonly string[]).includes(value);
}
