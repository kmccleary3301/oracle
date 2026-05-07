import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getOracleHomeDir } from "../oracleHome.js";
import type {
  OracleJobCreateInput,
  OracleJobEvent,
  OracleJobPhase,
  OracleJobRecord,
  OracleJobResultResponse,
  OracleJobStatus,
} from "./types.js";

export interface OracleJobStoreOptions {
  rootDir?: string;
}

export class OracleJobStore {
  readonly rootDir: string;

  constructor(options: OracleJobStoreOptions = {}) {
    this.rootDir = path.resolve(options.rootDir ?? defaultJobRootDir());
  }

  async createJob(input: OracleJobCreateInput): Promise<OracleJobRecord> {
    const now = new Date().toISOString();
    const id = createSortableJobId(new Date(now));
    const jobDir = this.jobDir(id);
    await fs.mkdir(jobDir, { recursive: true });
    const inputPath = path.join(jobDir, "input.json");
    const eventLogPath = path.join(jobDir, "events.ndjson");
    const job: OracleJobRecord = {
      id,
      kind: input.kind,
      status: "queued",
      phase: "accepted",
      createdAt: now,
      updatedAt: now,
      inputSummary: input.inputSummary ?? summarizeJobInput(input.input),
      inputPath,
      eventLogPath,
    };
    await atomicWriteJson(inputPath, input.input ?? {});
    await fs
      .writeFile(eventLogPath, "", { flag: "wx" })
      .catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    await this.writeJob(job);
    await this.appendEvent(id, "info", "accepted", `Accepted ${input.kind} job.`);
    return job;
  }

  async readJob(id: string): Promise<OracleJobRecord | null> {
    try {
      return JSON.parse(await fs.readFile(this.jobPath(id), "utf8")) as OracleJobRecord;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw error;
    }
  }

  async readInput(id: string): Promise<unknown> {
    const job = await this.requireJob(id);
    return JSON.parse(await fs.readFile(job.inputPath, "utf8")) as unknown;
  }

  async updateJob(id: string, patch: Partial<OracleJobRecord>): Promise<OracleJobRecord> {
    const current = await this.requireJob(id);
    const next: OracleJobRecord = {
      ...current,
      ...patch,
      id: current.id,
      kind: current.kind,
      createdAt: current.createdAt,
      inputPath: current.inputPath,
      eventLogPath: current.eventLogPath,
      updatedAt: new Date().toISOString(),
    };
    await this.writeJob(next);
    return next;
  }

  async transitionJob(
    id: string,
    status: OracleJobStatus,
    phase: OracleJobPhase,
    message?: string,
  ): Promise<OracleJobRecord> {
    const now = new Date().toISOString();
    const completed = status === "completed" || status === "failed" || status === "cancelled";
    const job = await this.updateJob(id, {
      status,
      phase,
      ...(status === "running" ? { startedAt: now } : {}),
      ...(completed ? { completedAt: now } : {}),
    });
    await this.appendEvent(id, status === "failed" ? "error" : "info", phase, message ?? status);
    return job;
  }

  async appendEvent(
    id: string,
    level: OracleJobEvent["level"],
    phase: OracleJobPhase,
    message: string,
    data?: unknown,
  ): Promise<OracleJobEvent> {
    const job = await this.requireJob(id);
    const seq = (await this.readEvents(id)).at(-1)?.seq ?? 0;
    const event: OracleJobEvent = {
      seq: seq + 1,
      timestamp: new Date().toISOString(),
      level,
      phase,
      message,
      ...(data === undefined ? {} : { data }),
    };
    await fs.appendFile(job.eventLogPath, `${JSON.stringify(event)}\n`, "utf8");
    await this.updateJob(id, { progress: { label: message, heartbeatAt: event.timestamp } });
    return event;
  }

  async readEvents(id: string, afterSeq = 0): Promise<OracleJobEvent[]> {
    const job = await this.requireJob(id);
    const raw = await fs
      .readFile(job.eventLogPath, "utf8")
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as OracleJobEvent)
      .filter((event) => event.seq > afterSeq);
  }

  async writeResult(id: string, result: unknown): Promise<OracleJobRecord> {
    const resultPath = path.join(this.jobDir(id), "result.json");
    await atomicWriteJson(resultPath, result);
    return await this.updateJob(id, {
      resultPath,
      resultSummary: summarizeResult(result),
    });
  }

  async readResult(id: string): Promise<OracleJobResultResponse> {
    const job = await this.readJob(id);
    if (!job) return { found: false, ready: false };
    if (!job.resultPath) return { found: true, ready: false, job };
    try {
      const result = JSON.parse(await fs.readFile(job.resultPath, "utf8")) as unknown;
      return { found: true, ready: true, job, result };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { found: true, ready: false, job };
      throw error;
    }
  }

  async listJobs(limit = 20): Promise<OracleJobRecord[]> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const jobs: OracleJobRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("job_")) continue;
      try {
        const job = await this.readJob(entry.name);
        if (job) jobs.push(job);
      } catch {
        // Corrupt job records should not make listing unusable.
      }
    }
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.max(1, limit));
  }

  async reconcileInterruptedJobs(): Promise<OracleJobRecord[]> {
    const jobs = await this.listJobs(Number.MAX_SAFE_INTEGER);
    const reconciled: OracleJobRecord[] = [];
    for (const job of jobs) {
      if (
        job.status === "queued" ||
        job.status === "starting" ||
        job.status === "running" ||
        job.status === "waiting_for_model" ||
        job.status === "extracting_artifacts" ||
        job.status === "cancel_requested"
      ) {
        const next = await this.updateJob(job.id, {
          status: "failed",
          phase: "failed",
          completedAt: new Date().toISOString(),
          error: {
            message: "Daemon restarted before this job completed.",
            code: "daemon_restarted",
            retryable: true,
            requiresAction: "daemon_restarted",
          },
        });
        await this.appendEvent(
          job.id,
          "error",
          "failed",
          "Marked interrupted job after daemon restart.",
        );
        reconciled.push(next);
      }
    }
    return reconciled;
  }

  async pruneJobs(retentionMs: number): Promise<string[]> {
    const cutoff = Date.now() - retentionMs;
    const jobs = await this.listJobs(Number.MAX_SAFE_INTEGER);
    const deleted: string[] = [];
    for (const job of jobs) {
      if (!["completed", "failed", "cancelled"].includes(job.status)) continue;
      const completedAt = Date.parse(job.completedAt ?? job.updatedAt);
      if (Number.isNaN(completedAt) || completedAt >= cutoff) continue;
      await fs.rm(this.jobDir(job.id), { recursive: true, force: true });
      deleted.push(job.id);
    }
    return deleted;
  }

  jobDir(id: string): string {
    return path.join(this.rootDir, id);
  }

  jobPath(id: string): string {
    return path.join(this.jobDir(id), "job.json");
  }

  private async requireJob(id: string): Promise<OracleJobRecord> {
    const job = await this.readJob(id);
    if (!job) throw new Error(`Oracle job ${id} was not found.`);
    return job;
  }

  private async writeJob(job: OracleJobRecord): Promise<void> {
    await fs.mkdir(this.jobDir(job.id), { recursive: true });
    await atomicWriteJson(this.jobPath(job.id), job);
  }
}

export function defaultJobRootDir(): string {
  return path.join(getOracleHomeDir(), "jobs");
}

export function createSortableJobId(date = new Date()): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `job_${stamp}_${randomBytes(4).toString("hex")}`;
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  const handle = await fs.open(
    tempPath,
    constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync().catch(() => {});
  } finally {
    await handle.close();
  }
  await fs.rename(tempPath, filePath);
}

function summarizeJobInput(input: unknown) {
  if (!input || typeof input !== "object") return {};
  const record = input as {
    prompt?: string;
    files?: unknown[];
    outputDir?: string;
    browserModelLabel?: string;
    browserThinkingTime?: string;
    projectUrl?: string;
    returnAfterSubmit?: boolean;
  };
  return {
    ...(typeof record.prompt === "string" ? { promptChars: record.prompt.length } : {}),
    ...(Array.isArray(record.files) ? { attachmentCount: record.files.length } : {}),
    ...(typeof record.outputDir === "string" ? { outputDir: record.outputDir } : {}),
    ...(typeof record.browserModelLabel === "string"
      ? { modelLabel: record.browserModelLabel }
      : {}),
    ...(typeof record.browserThinkingTime === "string"
      ? { thinkingTime: record.browserThinkingTime }
      : {}),
    ...(typeof record.projectUrl === "string" ? { projectUrl: record.projectUrl } : {}),
    ...(typeof record.returnAfterSubmit === "boolean"
      ? { returnAfterSubmit: record.returnAfterSubmit }
      : {}),
  };
}

function summarizeResult(result: unknown) {
  const record = result as {
    answerText?: string;
    answerMarkdown?: string;
    artifacts?: unknown[];
    downloadedArtifacts?: unknown[];
    downloadedSandboxArtifacts?: unknown[];
    warnings?: unknown[];
  };
  const text = typeof record?.answerText === "string" ? record.answerText : record?.answerMarkdown;
  return {
    ...(typeof text === "string" ? { answerChars: text.length } : {}),
    ...(Array.isArray(record?.artifacts) ? { imageArtifacts: record.artifacts.length } : {}),
    ...(Array.isArray(record?.downloadedArtifacts)
      ? { sandboxArtifacts: record.downloadedArtifacts.length }
      : {}),
    ...(Array.isArray(record?.downloadedSandboxArtifacts)
      ? { sandboxArtifacts: record.downloadedSandboxArtifacts.length }
      : {}),
    ...(Array.isArray(record?.warnings) ? { warnings: record.warnings.length } : {}),
  };
}

export function tempJobRootForTest(prefix = "oracle-jobs-"): string {
  return path.join(os.tmpdir(), `${prefix}${process.pid}-${Date.now()}`);
}
