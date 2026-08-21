import type { BrowserResponseProvenance } from "../browser/types.js";
import type { ApprovalChallenge } from "../browser/approvalToken.js";
import type { AdaptivePollObservation, AdaptivePollState } from "../jobs/adaptivePolling.js";
import type {
  OracleJobActionRequired,
  OracleJobKind,
  OracleJobOutcome,
  OracleJobPhase,
  OracleJobRuntime,
  OracleJobStatus,
  OracleJobSubmissionState,
  OracleWorkState,
} from "../jobs/types.js";
export interface OracleDaemonConfig {
  host: string;
  port: number;
  token: string;
  jobDir?: string;
  maxConcurrentJobs: number;
  maxQueuedJobs?: number;
  maxQueuedPersistedInputBytes?: number;
  maxPrincipalQueuedJobs?: number;
  maxPrincipalQueuedInputBytes?: number;
  maxPrincipalAdmissionsPerWindow?: number;
  principalRateWindowMs?: number;
}

export interface OracleDaemonConnection {
  version: 1;
  pid: number;
  host: string;
  port: number;
  token: string;
  startedAt: string;
  jobDir: string;
  generation?: number;
}

export interface OracleDaemonJobRequest {
  kind: OracleJobKind;
  input?: unknown;
  inputSummary?: Record<string, unknown>;
  idempotencyKey?: string;
  conversationId?: string;
  expectedHead?: string;
}

export interface OracleDaemonJobStartResponse {
  jobId: string;
  kind: OracleJobKind;
  status: OracleJobStatus;
  phase: OracleJobPhase;
  outcome?: OracleJobOutcome;
  reasonCode?: string;
  actionRequired?: OracleJobActionRequired;
  attempt?: number;
  generation?: number;
  pollTool: "oracle_job_status";
  attachTool: "oracle_job_events";
  resultTool: "oracle_job_result";
  estimatedQueuePosition: number;
}

export interface OracleDaemonJobHandlerContext {
  jobId: string;
  signal: AbortSignal;
  setPhase(phase: OracleJobPhase | string, message: string): Promise<void>;
  updateRuntime(runtime: Partial<OracleJobRuntime>): Promise<void>;
  markSubmission(
    state: OracleJobSubmissionState,
    metadata?: {
      conversationId?: string;
      expectedHead?: string;
      reasonCode?: string;
      evidencePath?: string;
    },
  ): Promise<void>;
  log(message: string, data?: unknown): Promise<void>;
}
export interface OracleDaemonJobPollResult extends AdaptivePollObservation {
  /** Optional terminal payload written to the durable job result. */
  result?: unknown;
}

export interface OracleDaemonJobHandler {
  kind: OracleJobKind;
  run(context: OracleDaemonJobHandlerContext, input: unknown): Promise<unknown>;
  poll?(
    context: OracleDaemonJobHandlerContext,
    input: unknown,
    state: AdaptivePollState,
  ): Promise<OracleDaemonJobPollResult>;
  cleanup?(context: OracleDaemonJobHandlerContext): Promise<void>;
}
export type OracleDaemonWorkOperation = "start" | "status" | "answer" | "approve" | "interrupt";
export interface OracleDaemonWorkTaskMetadata {
  taskId?: string;
  task?: string;
  deliverable?: string;
  deliverables?: Record<string, unknown> | unknown[];
}

export interface OracleDaemonWorkInput extends OracleDaemonWorkTaskMetadata {
  prompt?: string;
  answer?: string;
  conversationId?: string;
  questionId?: string;
  turnId?: string;
  expectedRevisionHash?: string;
  approvalGrant?: string;
  dryRun?: boolean;
  remoteChrome?: string;
  timeoutMs?: number;
  keepTab?: boolean;
}

export interface OracleDaemonWorkResult extends OracleDaemonWorkTaskMetadata {
  operation: OracleDaemonWorkOperation;
  state: OracleWorkState;
  accepted?: boolean;
  verified?: boolean;
  dryRun?: boolean;
  approvalChallenge?: ApprovalChallenge | null;
  reason?: string;
  conversationId?: string | null;
  conversationUrl?: string | null;
  questionId?: string | null;
  turnId?: string | null;
  provenance?: BrowserResponseProvenance[];
  revisionHash?: string | null;
  plan?: Record<string, unknown>;
  userQuestion?: Record<string, unknown>;
  requiresAction?: OracleJobActionRequired;
}
