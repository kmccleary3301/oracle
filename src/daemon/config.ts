import path from "node:path";
import { getOracleHomeDir } from "../oracleHome.js";
import { loadUserConfig } from "../config.js";

export interface ResolvedOracleDaemonConfig {
  enabled: boolean;
  autoStart: boolean;
  host: string;
  port: number;
  token?: string;
  connectionPath: string;
  jobDir: string;
  maxConcurrentJobs: number;
  maxQueuedJobs: number;
  maxQueuedPersistedInputBytes: number;
  maxPrincipalQueuedJobs: number;
  maxPrincipalQueuedInputBytes: number;
  maxPrincipalAdmissionsPerWindow: number;
  principalRateWindowMs: number;
  maxOpenChatgptTabs: number;
  jobRetentionDays: number;
  completedRetentionDays: number;
  failedRetentionDays: number;
  defaultPollIntervalMs: number;
}

export async function resolveOracleDaemonConfig(): Promise<ResolvedOracleDaemonConfig> {
  const { config } = await loadUserConfig();
  const daemon = config.daemon ?? {};
  const home = getOracleHomeDir();
  return {
    enabled: parseBooleanEnv(process.env.ORACLE_DAEMON_ENABLED) ?? daemon.enabled ?? true,
    autoStart: parseBooleanEnv(process.env.ORACLE_DAEMON_AUTOSTART) ?? daemon.autoStart ?? true,
    host: process.env.ORACLE_DAEMON_HOST ?? daemon.host ?? "127.0.0.1",
    port: parseNumberEnv(process.env.ORACLE_DAEMON_PORT) ?? daemon.port ?? 9473,
    token: process.env.ORACLE_DAEMON_TOKEN ?? daemon.token,
    connectionPath:
      process.env.ORACLE_DAEMON_CONNECTION ??
      daemon.connectionPath ??
      path.join(home, "daemon", "connection.json"),
    jobDir: process.env.ORACLE_JOBS_DIR ?? daemon.jobDir ?? path.join(home, "jobs"),
    maxConcurrentJobs: positiveNumber(
      parseNumberEnv(process.env.ORACLE_MAX_CONCURRENT_JOBS) ?? daemon.maxConcurrentJobs ?? 1,
      1,
    ),
    maxQueuedJobs: positiveNumber(
      parseNumberEnv(process.env.ORACLE_MAX_QUEUED_JOBS) ?? daemon.maxQueuedJobs ?? 256,
      256,
    ),
    maxQueuedPersistedInputBytes: positiveNumber(
      parseNumberEnv(
        process.env.ORACLE_MAX_QUEUED_PERSISTED_INPUT_BYTES ??
          process.env.ORACLE_MAX_QUEUED_INPUT_BYTES,
      ) ??
        daemon.maxQueuedPersistedInputBytes ??
        64 * 1024 * 1024,
      64 * 1024 * 1024,
    ),
    maxPrincipalQueuedJobs: positiveNumber(
      parseNumberEnv(process.env.ORACLE_MAX_PRINCIPAL_QUEUED_JOBS) ??
        daemon.maxPrincipalQueuedJobs ??
        128,
      128,
    ),
    maxPrincipalQueuedInputBytes: positiveNumber(
      parseNumberEnv(process.env.ORACLE_MAX_PRINCIPAL_QUEUED_INPUT_BYTES) ??
        daemon.maxPrincipalQueuedInputBytes ??
        32 * 1024 * 1024,
      32 * 1024 * 1024,
    ),
    maxPrincipalAdmissionsPerWindow: positiveNumber(
      parseNumberEnv(process.env.ORACLE_MAX_PRINCIPAL_ADMISSIONS_PER_WINDOW) ??
        daemon.maxPrincipalAdmissionsPerWindow ??
        128,
      128,
    ),
    principalRateWindowMs: positiveNumber(
      parseNumberEnv(process.env.ORACLE_PRINCIPAL_RATE_WINDOW_MS) ??
        daemon.principalRateWindowMs ??
        60_000,
      60_000,
    ),
    maxOpenChatgptTabs:
      parseNumberEnv(process.env.ORACLE_MAX_OPEN_CHATGPT_TABS) ?? daemon.maxOpenChatgptTabs ?? 4,
    jobRetentionDays: daemon.jobRetentionDays ?? 14,
    completedRetentionDays: daemon.completedRetentionDays ?? 7,
    failedRetentionDays: daemon.failedRetentionDays ?? 30,
    defaultPollIntervalMs: daemon.defaultPollIntervalMs ?? 5_000,
  };
}

function positiveNumber(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return undefined;
}

function parseNumberEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
