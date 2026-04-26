import http from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getCliVersion } from "../version.js";
import { OracleJobStore } from "../jobs/store.js";
import type { OracleJobPhase } from "../jobs/types.js";
import { isOracleJobKind } from "../jobs/types.js";
import type {
  OracleDaemonConnection,
  OracleDaemonJobHandler,
  OracleDaemonJobHandlerContext,
  OracleDaemonJobRequest,
  OracleDaemonJobStartResponse,
} from "./types.js";
import { createChatgptDaemonHandlers, recoverChatgptJobArtifacts } from "./chatgptHandlers.js";

export interface CreateOracleDaemonServerOptions {
  host?: string;
  port?: number;
  token?: string;
  jobDir?: string;
  maxConcurrentJobs?: number;
  connectionPath?: string;
  handlers?: OracleDaemonJobHandler[];
  logger?: (message: string) => void;
}

export interface OracleDaemonServerInstance {
  port: number;
  token: string;
  jobDir: string;
  close(): Promise<void>;
}

interface QueueEntry {
  jobId: string;
  handler: OracleDaemonJobHandler;
  input: unknown;
  controller: AbortController;
}

export async function createOracleDaemonServer(
  options: CreateOracleDaemonServerOptions = {},
): Promise<OracleDaemonServerInstance> {
  const host = options.host ?? "127.0.0.1";
  const token = options.token ?? randomBytes(16).toString("hex");
  const maxConcurrentJobs = Math.max(1, options.maxConcurrentJobs ?? 1);
  const store = new OracleJobStore({ rootDir: options.jobDir });
  const handlers = new Map<string, OracleDaemonJobHandler>();
  for (const handler of options.handlers ?? [
    createTestSleepHandler(),
    ...createChatgptDaemonHandlers(),
  ]) {
    handlers.set(handler.kind, handler);
  }
  const server = http.createServer();
  const logger = options.logger ?? (() => {});
  const startedAt = new Date().toISOString();
  const queue: QueueEntry[] = [];
  const running = new Map<string, QueueEntry>();
  const activeRuns = new Set<Promise<void>>();
  const cancelledJobs = new Set<string>();

  await mkdir(store.rootDir, { recursive: true });
  await store.reconcileInterruptedJobs();

  const pumpQueue = () => {
    while (running.size < maxConcurrentJobs && queue.length > 0) {
      const entry = queue.shift();
      if (!entry) return;
      running.set(entry.jobId, entry);
      const activeRun = runEntry(entry).finally(() => {
        running.delete(entry.jobId);
        activeRuns.delete(activeRun);
        pumpQueue();
      });
      activeRuns.add(activeRun);
    }
  };

  const runEntry = async (entry: QueueEntry) => {
    const context: OracleDaemonJobHandlerContext = {
      jobId: entry.jobId,
      signal: entry.controller.signal,
      setPhase: async (phase, message) => {
        const job = await store.readJob(entry.jobId);
        await store.updateJob(entry.jobId, {
          status: phase === "completed" ? "completed" : phase === "failed" ? "failed" : "running",
          phase: phase as OracleJobPhase,
          runtime: { ...(job?.runtime ?? {}), daemonPid: process.pid },
        });
        await store.appendEvent(
          entry.jobId,
          phase === "failed" ? "error" : "info",
          phase as OracleJobPhase,
          message,
        );
      },
      updateRuntime: async (runtime) => {
        const job = await store.readJob(entry.jobId);
        await store.updateJob(entry.jobId, {
          runtime: {
            ...(job?.runtime ?? {}),
            daemonPid: process.pid,
            ...runtime,
          },
        });
      },
      log: async (message, data) => {
        const job = await store.readJob(entry.jobId);
        await store.appendEvent(entry.jobId, "info", job?.phase ?? "queued", message, data);
      },
    };
    try {
      await store.transitionJob(entry.jobId, "running", "queued", "Starting queued job.");
      const result = await entry.handler.run(context, entry.input);
      if (entry.controller.signal.aborted || cancelledJobs.has(entry.jobId)) {
        await store.appendEvent(
          entry.jobId,
          "warn",
          "closing_tabs",
          "Ignored late result from cancelled job.",
        );
        return;
      }
      await store.writeResult(entry.jobId, result);
      await store.transitionJob(entry.jobId, "completed", "completed", "Job completed.");
    } catch (error) {
      const cancelled = entry.controller.signal.aborted;
      await store.updateJob(entry.jobId, {
        status: cancelled ? "cancelled" : "failed",
        phase: cancelled ? "closing_tabs" : "failed",
        completedAt: new Date().toISOString(),
        error: cancelled
          ? undefined
          : {
              message: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
      });
      await store.appendEvent(
        entry.jobId,
        cancelled ? "warn" : "error",
        cancelled ? "closing_tabs" : "failed",
        cancelled
          ? "Job cancelled."
          : `Job failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      cancelledJobs.delete(entry.jobId);
    }
  };

  server.on("request", async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/status") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (!isAuthorized(req, token)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          version: getCliVersion(),
          uptimeSeconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/daemon/status") {
        sendJson(res, 200, {
          ok: true,
          version: getCliVersion(),
          pid: process.pid,
          startedAt,
          activeJobCount: running.size,
          queuedJobCount: queue.length,
          jobDir: store.rootDir,
          maxConcurrentJobs,
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/daemon/stop") {
        sendJson(res, 200, { ok: true, stopping: true });
        setTimeout(() => {
          server.close(() => undefined);
        }, 10).unref();
        return;
      }
      if (req.method === "POST" && url.pathname === "/jobs") {
        const parsed = JSON.parse(await readRequestBody(req)) as OracleDaemonJobRequest;
        if (!parsed.kind || !isOracleJobKind(parsed.kind)) {
          sendJson(res, 400, { error: "invalid_job_kind" });
          return;
        }
        const handler = handlers.get(parsed.kind);
        if (!handler) {
          sendJson(res, 400, { error: "unsupported_job_kind" });
          return;
        }
        const job = await store.createJob({
          kind: parsed.kind,
          input: parsed.input,
          inputSummary: parsed.inputSummary,
        });
        const entry: QueueEntry = {
          jobId: job.id,
          handler,
          input: parsed.input,
          controller: new AbortController(),
        };
        queue.push(entry);
        const queuePosition = queue.length - 1;
        await store.updateJob(job.id, { queuePosition, phase: "queued" });
        await store.appendEvent(job.id, "info", "queued", `Queued ${parsed.kind} job.`);
        pumpQueue();
        const response: OracleDaemonJobStartResponse = {
          jobId: job.id,
          kind: parsed.kind,
          status: queuePosition === 0 && running.has(job.id) ? "running" : "queued",
          phase: "queued",
          pollTool: "oracle_job_status",
          attachTool: "oracle_job_events",
          resultTool: "oracle_job_result",
          estimatedQueuePosition: queuePosition,
        };
        sendJson(res, 202, response);
        return;
      }
      if (req.method === "GET" && url.pathname === "/jobs") {
        sendJson(res, 200, {
          jobs: await store.listJobs(Number(url.searchParams.get("limit") ?? 20)),
        });
        return;
      }
      const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)(?:\/(events|result|cancel|recover))?$/);
      if (jobMatch) {
        const jobId = decodeURIComponent(jobMatch[1]);
        const action = jobMatch[2];
        if (!action && req.method === "GET") {
          const job = await store.readJob(jobId);
          sendJson(res, job ? 200 : 404, {
            found: Boolean(job),
            job: job ? { ...job, resultReady: Boolean(job.resultPath) } : undefined,
          });
          return;
        }
        if (action === "events" && req.method === "GET") {
          const after = Number(url.searchParams.get("after") ?? 0);
          sendJson(res, 200, {
            found: Boolean(await store.readJob(jobId)),
            events: await store.readEvents(jobId, after),
          });
          return;
        }
        if (action === "result" && req.method === "GET") {
          const result = await store.readResult(jobId);
          sendJson(res, result.found ? (result.ready ? 200 : 202) : 404, result);
          return;
        }
        if (action === "cancel" && req.method === "POST") {
          const entry = running.get(jobId) ?? queue.find((item) => item.jobId === jobId);
          if (!entry) {
            sendJson(res, 404, { found: false });
            return;
          }
          entry.controller.abort();
          const queuedIndex = queue.findIndex((item) => item.jobId === jobId);
          if (queuedIndex >= 0) {
            queue.splice(queuedIndex, 1);
            await store.transitionJob(jobId, "cancelled", "closing_tabs", "Cancelled queued job.");
          } else {
            cancelledJobs.add(jobId);
            running.delete(jobId);
            await store.updateJob(jobId, {
              status: "cancelled",
              phase: "closing_tabs",
              completedAt: new Date().toISOString(),
            });
            await store.appendEvent(
              jobId,
              "warn",
              "closing_tabs",
              "Cancellation requested; released daemon queue slot.",
            );
            pumpQueue();
          }
          sendJson(res, 200, { found: true, job: await store.readJob(jobId) });
          return;
        }
        if (action === "recover" && req.method === "POST") {
          const job = await store.readJob(jobId);
          if (!job) {
            sendJson(res, 404, { found: false });
            return;
          }
          const body = JSON.parse((await readRequestBody(req)) || "{}") as Record<string, unknown>;
          await store.appendEvent(
            jobId,
            "warn",
            job.phase,
            "Attempting artifact recovery for stale or incomplete job.",
            body,
          );
          const result = await recoverChatgptJobArtifacts({
            ...body,
            jobId,
            jobRuntime: job.runtime,
          });
          await store.writeResult(jobId, {
            ...result,
            recoveredJobId: jobId,
            originalStatus: job.status,
            originalPhase: job.phase,
          });
          await store.transitionJob(
            jobId,
            "completed",
            "completed",
            "Job completed through artifact recovery.",
          );
          sendJson(res, 200, {
            found: true,
            recovered: true,
            job: await store.readJob(jobId),
            result,
          });
          return;
        }
      }
      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      logger(error instanceof Error ? (error.stack ?? error.message) : String(error));
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Unable to determine daemon address.");
  const connection: OracleDaemonConnection = {
    version: 1,
    pid: process.pid,
    host,
    port: address.port,
    token,
    startedAt,
    jobDir: store.rootDir,
  };
  if (options.connectionPath) {
    await writeConnectionArtifact(options.connectionPath, connection);
  }

  return {
    port: address.port,
    token,
    jobDir: store.rootDir,
    async close() {
      for (const entry of running.values()) entry.controller.abort();
      await Promise.race([
        Promise.allSettled(activeRuns),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export async function findAvailableDaemonPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (typeof address === "object" && address?.port) {
        srv.close(() => resolve(address.port));
      } else {
        srv.close(() => reject(new Error("Unable to allocate daemon port.")));
      }
    });
  });
}

export async function writeConnectionArtifact(
  filePath: string,
  connection: OracleDaemonConnection,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(connection, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => {});
}

function createTestSleepHandler(): OracleDaemonJobHandler {
  return {
    kind: "test_sleep",
    async run(context, input) {
      const record = input as { ms?: number; result?: unknown };
      const ms = Math.max(0, Math.min(record?.ms ?? 10, 30_000));
      await context.setPhase("waiting_for_response", `Sleeping for ${ms}ms.`);
      await sleep(ms, context.signal);
      await context.log("Test sleep completed.");
      return record?.result ?? { ok: true, sleptMs: ms };
    },
  };
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("cancelled"));
      },
      { once: true },
    );
  });
}

function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  return req.headers.authorization === `Bearer ${token}`;
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
