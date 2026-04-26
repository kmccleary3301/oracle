import { randomUUID } from "node:crypto";

export type McpJobStatus = "running" | "completed" | "failed";

export type McpJobRecord<T = unknown> = {
  id: string;
  kind: string;
  status: McpJobStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: T;
  error?: string;
};

const jobs = new Map<string, McpJobRecord>();

export function startMcpJob<T>(kind: string, task: () => Promise<T>): McpJobRecord<T> {
  const now = new Date().toISOString();
  const job: McpJobRecord<T> = {
    id: randomUUID(),
    kind,
    status: "running",
    startedAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);

  void task()
    .then((result) => {
      const completedAt = new Date().toISOString();
      job.status = "completed";
      job.updatedAt = completedAt;
      job.completedAt = completedAt;
      job.result = result;
    })
    .catch((error: unknown) => {
      const completedAt = new Date().toISOString();
      job.status = "failed";
      job.updatedAt = completedAt;
      job.completedAt = completedAt;
      job.error = error instanceof Error ? error.stack || error.message : String(error);
    });

  return job;
}

export function getMcpJob(id: string): McpJobRecord | undefined {
  return jobs.get(id);
}

export function listMcpJobs(limit = 20): McpJobRecord[] {
  return [...jobs.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, Math.max(1, limit));
}
