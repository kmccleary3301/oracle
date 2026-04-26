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
    maxConcurrentJobs: daemon.maxConcurrentJobs ?? 1,
    maxOpenChatgptTabs:
      parseNumberEnv(process.env.ORACLE_MAX_OPEN_CHATGPT_TABS) ?? daemon.maxOpenChatgptTabs ?? 4,
    jobRetentionDays: daemon.jobRetentionDays ?? 14,
    completedRetentionDays: daemon.completedRetentionDays ?? 7,
    failedRetentionDays: daemon.failedRetentionDays ?? 30,
    defaultPollIntervalMs: daemon.defaultPollIntervalMs ?? 5_000,
  };
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
