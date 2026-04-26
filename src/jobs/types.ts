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
] as const;

export type OracleJobStatus = (typeof ORACLE_JOB_STATUSES)[number];

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
] as const;

export type OracleJobPhase = (typeof ORACLE_JOB_PHASES)[number];

export const ORACLE_JOB_KINDS = [
  "chatgpt_create_session",
  "chatgpt_send_turn",
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
] as const;

export type OracleJobActionReason = (typeof ORACLE_JOB_ACTION_REASONS)[number];

export interface OracleJobInputSummary {
  promptChars?: number;
  attachmentCount?: number;
  outputDir?: string;
  modelLabel?: string;
  thinkingTime?: string;
  projectUrl?: string;
}

export interface OracleJobRuntime {
  daemonPid?: number;
  browserProfileDir?: string;
  remoteChrome?: string;
  tabId?: string;
  conversationUrl?: string;
  conversationId?: string;
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
  retryable?: boolean;
  requiresAction?: OracleJobActionReason | string;
}

export interface OracleJobRecord {
  id: string;
  kind: OracleJobKind;
  status: OracleJobStatus;
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
  runtime?: OracleJobRuntime;
  resultSummary?: OracleJobResultSummary;
  resultPath?: string;
  inputPath: string;
  eventLogPath: string;
  error?: OracleJobError;
  debugArtifacts?: string[];
}

export interface OracleJobEvent {
  seq: number;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  phase: OracleJobPhase;
  message: string;
  data?: unknown;
}

export interface OracleJobCreateInput {
  kind: OracleJobKind;
  input?: unknown;
  inputSummary?: OracleJobInputSummary;
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
