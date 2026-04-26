import type { OracleJobKind, OracleJobRuntime } from "../jobs/types.js";

export interface OracleDaemonConfig {
  host: string;
  port: number;
  token: string;
  jobDir?: string;
  maxConcurrentJobs: number;
}

export interface OracleDaemonConnection {
  version: 1;
  pid: number;
  host: string;
  port: number;
  token: string;
  startedAt: string;
  jobDir: string;
}

export interface OracleDaemonJobRequest {
  kind: OracleJobKind;
  input?: unknown;
  inputSummary?: Record<string, unknown>;
}

export interface OracleDaemonJobStartResponse {
  jobId: string;
  kind: OracleJobKind;
  status: string;
  phase: string;
  pollTool: "oracle_job_status";
  attachTool: "oracle_job_events";
  resultTool: "oracle_job_result";
  estimatedQueuePosition: number;
}

export interface OracleDaemonJobHandlerContext {
  jobId: string;
  signal: AbortSignal;
  setPhase(phase: string, message: string): Promise<void>;
  updateRuntime(runtime: Partial<OracleJobRuntime>): Promise<void>;
  log(message: string, data?: unknown): Promise<void>;
}

export interface OracleDaemonJobHandler {
  kind: OracleJobKind;
  run(context: OracleDaemonJobHandlerContext, input: unknown): Promise<unknown>;
}
