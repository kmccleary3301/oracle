import http from "node:http";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApprovalGrantAuthority } from "../browser/approvalToken.js";
import { getCliVersion } from "../version.js";
import {
  AdaptivePollingScheduler,
  computeAdaptivePollPlan,
  isTerminalPollState,
  type AdaptivePollState,
  type ScheduledAdaptivePollJob,
} from "../jobs/adaptivePolling.js";
import {
  OracleJobAdmissionError,
  OracleJobIdempotencyConflictError,
  OracleJobStore,
} from "../jobs/store.js";
import type { OracleJobKind, OracleJobPhase, OracleJobStatus } from "../jobs/types.js";
import { isOracleJobKind } from "../jobs/types.js";
import type {
  OracleDaemonConnection,
  OracleDaemonJobHandler,
  OracleDaemonJobHandlerContext,
  OracleDaemonJobRequest,
  OracleDaemonJobStartResponse,
  OracleDaemonWorkOperation,
} from "./types.js";
import {
  createChatgptDaemonHandlers,
  recoverChatgptJobArtifacts,
  runChatgptWorkOperation,
} from "./chatgptHandlers.js";
import { createResearchDaemonHandlers } from "./researchHandlers.js";

const MAX_DAEMON_REQUEST_BYTES = 16 * 1024 * 1024;

class DaemonRequestTooLargeError extends Error {}

export interface CreateOracleDaemonServerOptions {
  host?: string;
  port?: number;
  token?: string;
  jobDir?: string;
  maxConcurrentJobs?: number;
  maxQueuedJobs?: number;
  maxQueuedPersistedInputBytes?: number;
  maxQueuedInputBytes?: number;
  maxPrincipalQueuedJobs?: number;
  maxPrincipalQueuedInputBytes?: number;
  maxPrincipalAdmissionsPerWindow?: number;
  principalRateWindowMs?: number;
  jobRetentionMs?: number;
  connectionPath?: string;
  handlers?: OracleDaemonJobHandler[];
  logger?: (message: string) => void;
  approvalAuthority?: ApprovalGrantAuthority;
  principal?: string;
  session?: string;
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
  kind: OracleJobKind;
  input: unknown;
  controller: AbortController;
  generation: number;
  leaseId: string;
}

export async function createOracleDaemonServer(
  options: CreateOracleDaemonServerOptions = {},
): Promise<OracleDaemonServerInstance> {
  const host = options.host ?? "127.0.0.1";
  const token = options.token ?? randomBytes(16).toString("hex");
  const principalHash = createHash("sha256").update(token).digest("hex");
  const maxConcurrentJobs = Math.max(1, options.maxConcurrentJobs ?? 1);
  const store = new OracleJobStore({
    rootDir: options.jobDir,
    maxQueuedJobs: options.maxQueuedJobs,
    maxQueuedPersistedInputBytes: options.maxQueuedPersistedInputBytes,
    maxQueuedInputBytes: options.maxQueuedInputBytes,
    maxPrincipalQueuedJobs: options.maxPrincipalQueuedJobs,
    maxPrincipalQueuedInputBytes: options.maxPrincipalQueuedInputBytes,
    maxPrincipalAdmissionsPerWindow: options.maxPrincipalAdmissionsPerWindow,
    principalRateWindowMs: options.principalRateWindowMs,
  });
  const handlers = new Map<string, OracleDaemonJobHandler>();
  for (const handler of options.handlers ?? [
    createTestSleepHandler(),
    ...createChatgptDaemonHandlers({
      approvalAuthority: options.approvalAuthority,
      principal: options.principal,
      session: options.session,
    }),
    ...createResearchDaemonHandlers({
      approvalAuthority: options.approvalAuthority,
      principal: options.principal,
      session: options.session,
    }),
  ]) {
    handlers.set(handler.kind, handler);
  }
  const server = http.createServer();
  const logger = options.logger ?? (() => {});
  const startedAt = new Date().toISOString();
  const daemonGeneration = Date.now();
  const queue: QueueEntry[] = [];
  const running = new Map<string, QueueEntry>();
  const activeRuns = new Set<Promise<void>>();
  const jobRetentionMs = Math.max(0, options.jobRetentionMs ?? 14 * 24 * 60 * 60_000);

  await mkdir(store.rootDir, { recursive: true });
  await store.reconcileInterruptedJobs();
  await store.pruneJobs(jobRetentionMs);
  const retentionTimer = setInterval(
    () => {
      void store.pruneJobs(jobRetentionMs).catch((error) => {
        logger(
          `Daemon job retention failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
    Math.max(60_000, Math.min(60 * 60_000, jobRetentionMs || 60_000)),
  );
  retentionTimer.unref();
  const polling = new AdaptivePollingScheduler<{
    leaseId: string;
    generation: number;
  }>({
    loadDuePolls: async () => {
      const jobs = await store.listJobs(Number.MAX_SAFE_INTEGER);
      const due: ScheduledAdaptivePollJob[] = [];
      for (const job of jobs) {
        if (!job.runtime?.poll?.dueAt) continue;
        due.push({
          id: job.id,
          status: job.status,
          state: job.runtime.poll,
          input: await store.readInput(job.id),
        });
      }
      return due;
    },
    persistPollState: async (jobId, state) => {
      const job = await store.readJob(jobId);
      if (!job || job.status === "cancel_requested" || isTerminalStatus(job.status)) return;
      await store.updatePollState(jobId, state, { expectedStatus: job.status });
    },
    acquirePollingLease: async (job) => {
      const current = await store.readJob(job.id);
      if (!current || current.status === "cancel_requested" || isTerminalStatus(current.status)) {
        throw new Error("poll cancelled");
      }
      const leaseId = `poll_${randomBytes(12).toString("hex")}`;
      const acquired = await store.acquireOwnerLease(job.id, {
        generation: daemonGeneration,
        leaseId,
        role: "polling",
        expectedGeneration: current.generation,
        expectedOwnerLeaseId: current.ownerLeaseId ?? null,
      });
      if (!acquired) throw new Error("poll lease lost");
      return { leaseId, generation: acquired.generation };
    },
    poll: async (job, lease, signal) => {
      const current = await store.readJob(job.id);
      const handler = current ? handlers.get(current.kind) : undefined;
      if (!current || !handler?.poll) return { state: "completed", terminal: true };
      const context = createPollContext(store, current.id, lease.leaseId, signal);
      const result = await handler.poll(context, job.input, current.runtime?.poll ?? job.state);
      if (result.result !== undefined) await store.writeResult(job.id, result.result);
      if (result.terminal || result.cancelled || isTerminalPollState(result.state)) {
        const after = await store.readJob(job.id);
        if (after && !isTerminalStatus(after.status)) {
          await store.transitionJob({
            id: job.id,
            expectedStatus: after.status,
            nextStatus: result.cancelled
              ? "cancelled"
              : result.state === "conflict"
                ? "conflict"
                : "completed",
            phase: result.cancelled
              ? "cancelled"
              : result.state === "conflict"
                ? "conflict"
                : "completed",
            outcome: result.cancelled
              ? "cancelled"
              : result.state === "conflict"
                ? "conflict"
                : "success",
            reasonCode: result.cancelled ? "cancelled" : "poll_completed",
          });
        }
      }
      return result;
    },
    releasePollingLease: async (lease, job) => {
      await store.updateJobIfCurrent(
        job.id,
        {
          ownerLeaseId: undefined,
          ownerGeneration: undefined,
          ownerLease: undefined,
          runtime: {
            ...(await store.readJob(job.id))?.runtime,
            tabId: undefined,
          },
        },
        { expectedOwnerLeaseId: lease.leaseId },
      );
    },
  });
  await polling.restoreDuePolls();
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
        if (!job || job.status !== "running" || entry.controller.signal.aborted) return;
        const updated = await store.updateJobIfCurrent(
          entry.jobId,
          {
            status: phase === "completed" ? "completed" : phase === "failed" ? "failed" : "running",
            phase: phase as OracleJobPhase,
            runtime: { ...(job.runtime ?? {}), daemonPid: process.pid },
          },
          {
            expectedStatus: "running",
            expectedGeneration: job.generation,
            expectedOwnerLeaseId: entry.leaseId,
          },
        );
        if (!updated) return;
        await store.appendEvent(
          entry.jobId,
          phase === "failed" ? "error" : "info",
          phase as OracleJobPhase,
          message,
        );
      },
      updateRuntime: async (runtime) => {
        const job = await store.readJob(entry.jobId);
        if (!job || job.status !== "running" || entry.controller.signal.aborted) return;
        await store.updateJobIfCurrent(
          entry.jobId,
          {
            runtime: {
              ...(job.runtime ?? {}),
              daemonPid: process.pid,
              ...runtime,
            },
          },
          {
            expectedStatus: "running",
            expectedGeneration: job.generation,
            expectedOwnerLeaseId: entry.leaseId,
          },
        );
      },
      markSubmission: async (state, metadata) => {
        const job = await store.readJob(entry.jobId);
        if (!job || job.status !== "running" || entry.controller.signal.aborted) return;
        await store.markSubmission(entry.jobId, state, {
          ...metadata,
          expectedGeneration: job.generation,
          expectedOwnerLeaseId: entry.leaseId,
        });
      },
      log: async (message, data) => {
        const job = await store.readJob(entry.jobId);
        await store.appendEvent(entry.jobId, "info", job?.phase ?? "queued", message, data);
      },
    };
    let result: unknown;
    let runError: unknown;
    try {
      await store.updateJob(entry.jobId, { queuePosition: undefined });
      const started = await store.transitionJob({
        id: entry.jobId,
        expectedStatus: "queued",
        nextStatus: "running",
        phase: "queued",
        message: "Starting queued job.",
        generation: entry.generation,
        ownerGeneration: entry.generation,
        ownerLeaseId: entry.leaseId,
      });
      if (!started) return;
      result = await entry.handler.run(context, entry.input);
    } catch (error) {
      runError = error;
    }

    let cleanupError: unknown;
    try {
      await entry.handler.cleanup?.(context);
    } catch (error) {
      cleanupError = error;
    }

    const current = await store.readJob(entry.jobId);
    if (!current) return;
    const cancelled = entry.controller.signal.aborted || current.status === "cancel_requested";
    if (cleanupError) {
      const actionRequired = {
        kind: "manual_confirmation_required",
        message: `Handler cleanup did not complete: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`,
        evidencePath: current.eventLogPath,
      };
      await store.transitionJob({
        id: entry.jobId,
        expectedStatus: current.status,
        nextStatus: "requires_action",
        phase: "requires_action",
        message: actionRequired.message,
        outcome: "requires_action",
        reasonCode: "cleanup_failed",
        actionRequired,
        error: {
          message: actionRequired.message,
          code: "cleanup_failed",
          reasonCode: "cleanup_failed",
          retryable: false,
          actionRequired,
          evidencePath: current.eventLogPath,
        },
      });
      return;
    }
    if (cancelled) {
      await store.transitionJob({
        id: entry.jobId,
        expectedStatus: current.status,
        nextStatus: "cancelled",
        phase: "cancelled",
        message: "Job cancelled after handler cleanup.",
        outcome: "cancelled",
        reasonCode: "cancelled",
      });
      return;
    }
    if (runError !== undefined) {
      const message = runError instanceof Error ? runError.message : String(runError);
      await store.transitionJob({
        id: entry.jobId,
        expectedStatus: current.status,
        nextStatus: "failed",
        phase: "failed",
        message: `Job failed: ${message}`,
        outcome: "failure",
        reasonCode: "handler_error",
        error: {
          message,
          stack: runError instanceof Error ? runError.stack : undefined,
          code: "handler_error",
          reasonCode: "handler_error",
          retryable: false,
        },
      });
      return;
    }
    await store.writeResult(entry.jobId, result);
    const afterResult = await store.readJob(entry.jobId);
    if (!afterResult) return;
    const submitted =
      result &&
      typeof result === "object" &&
      "status" in result &&
      (result as { status?: unknown }).status === "submitted";
    if (submitted) {
      const record = result as {
        thinkingTimeSelection?: { requestedThinkingTime?: string };
        earliestRecoveryAt?: string;
        conversationUrl?: string;
      };
      const plan = computeAdaptivePollPlan({
        now: Date.now(),
        state: { state: "submitted", attempts: 0 },
        thinkingClass: record.thinkingTimeSelection?.requestedThinkingTime,
        jitterSeed: entry.jobId,
      });
      const pollState: AdaptivePollState = {
        ...plan.state,
        ...(record.earliestRecoveryAt ? { dueAt: record.earliestRecoveryAt } : {}),
      };
      await store.transitionJob({
        id: entry.jobId,
        expectedStatus: afterResult.status,
        nextStatus: "waiting_for_model",
        phase: "waiting_for_response",
        message: "Submission acknowledged; scheduled nonresident polling.",
        ownerLeaseId: null,
        ownerGeneration: null,
        reasonCode: "poll_scheduled",
      });
      await store.updateJob(entry.jobId, {
        runtime: {
          ...(afterResult.runtime ?? {}),
          conversationUrl: record.conversationUrl ?? afterResult.runtime?.conversationUrl,
          poll: pollState,
        },
      });
      await polling.scheduleNonresidentPoll({
        id: entry.jobId,
        status: "waiting_for_model",
        state: pollState,
        input: entry.input,
      });
      return;
    }
    const workResult =
      entry.kind === "chatgpt_work_start" &&
      result &&
      typeof result === "object" &&
      "state" in result
        ? (result as { state?: string; reason?: string })
        : undefined;
    if (workResult) {
      const nextStatus =
        workResult.state === "conflict"
          ? "conflict"
          : workResult.state === "requires_action"
            ? "requires_action"
            : "completed";
      const actionRequired =
        workResult.state === "requires_action"
          ? {
              kind: "manual_confirmation_required",
              message: workResult.reason ?? "ChatGPT Work requires user action.",
              details: { state: workResult.state },
            }
          : undefined;
      await store.transitionJob({
        id: entry.jobId,
        expectedStatus: afterResult.status,
        nextStatus,
        phase: nextStatus === "completed" ? "completed" : nextStatus,
        message:
          nextStatus === "completed"
            ? "ChatGPT Work start completed."
            : "ChatGPT Work requires action.",
        outcome: nextStatus === "completed" ? "success" : nextStatus,
        reasonCode: workResult.reason ?? `work_${workResult.state ?? "unknown"}`,
        actionRequired,
      });
      return;
    }
    await store.transitionJob({
      id: entry.jobId,
      expectedStatus: afterResult.status,
      nextStatus: "completed",
      phase: "completed",
      message: "Job completed.",
      outcome: "success",
      reasonCode: "completed",
    });
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
      if (req.method === "POST" && (url.pathname === "/jobs" || url.pathname === "/work/start")) {
        const body = JSON.parse(await readRequestBody(req)) as
          | OracleDaemonJobRequest
          | Record<string, unknown>;
        const parsed =
          url.pathname === "/work/start"
            ? ({
                kind: "chatgpt_work_start",
                input: body,
                conversationId:
                  typeof body.conversationId === "string" ? body.conversationId : undefined,
              } satisfies OracleDaemonJobRequest)
            : (body as OracleDaemonJobRequest);
        if (!parsed.kind || !isOracleJobKind(parsed.kind)) {
          sendJson(res, 400, { error: "invalid_job_kind" });
          return;
        }
        const handler = handlers.get(parsed.kind);
        if (!handler) {
          sendJson(res, 400, { error: "unsupported_job_kind" });
          return;
        }
        const leaseId = `lease_${randomBytes(12).toString("hex")}`;
        const admission = await store.admitJob({
          kind: parsed.kind,
          input: parsed.input,
          inputSummary: parsed.inputSummary,
          idempotencyKey: parsed.idempotencyKey,
          conversationId: parsed.conversationId,
          expectedHead: parsed.expectedHead,
          principalHash,
          generation: daemonGeneration,
          ownerGeneration: daemonGeneration,
          ownerLeaseId: leaseId,
        });
        if (!admission.created) {
          const existing = admission.job;
          const queuedIndex = queue.findIndex((entry) => entry.jobId === existing.id);
          const response: OracleDaemonJobStartResponse = {
            jobId: existing.id,
            kind: existing.kind,
            status: existing.status,
            phase: existing.phase,
            outcome: existing.outcome,
            reasonCode: existing.reasonCode,
            actionRequired: existing.actionRequired,
            attempt: existing.attempt,
            generation: existing.generation,
            pollTool: "oracle_job_status",
            attachTool: "oracle_job_events",
            resultTool: "oracle_job_result",
            estimatedQueuePosition: queuedIndex >= 0 ? queuedIndex : 0,
          };
          sendJson(res, 200, response);
          return;
        }
        const job = admission.job;
        const entry: QueueEntry = {
          jobId: job.id,
          kind: parsed.kind,
          handler,
          input: parsed.input,
          controller: new AbortController(),
          generation: daemonGeneration,
          leaseId,
        };
        queue.push(entry);
        const queuePosition = queue.length - 1;
        await store.updateJob(job.id, { queuePosition, phase: "queued" });
        await store.appendEvent(job.id, "info", "queued", `Queued ${parsed.kind} job.`, undefined, {
          reasonCode: "queued",
        });
        pumpQueue();
        const current = (await store.readJob(job.id)) ?? job;
        const response: OracleDaemonJobStartResponse = {
          jobId: current.id,
          kind: current.kind,
          status: current.status,
          phase: current.phase,
          outcome: current.outcome,
          reasonCode: current.reasonCode,
          actionRequired: current.actionRequired,
          attempt: current.attempt,
          generation: current.generation,
          pollTool: "oracle_job_status",
          attachTool: "oracle_job_events",
          resultTool: "oracle_job_result",
          estimatedQueuePosition: queuePosition,
        };
        sendJson(res, 202, response);
        return;
      }
      const workMatch = url.pathname.match(/^\/work\/(status|answer|approve|interrupt)$/);
      if (workMatch && req.method === "POST") {
        const operation = workMatch[1] as Exclude<OracleDaemonWorkOperation, "start">;
        const body = JSON.parse((await readRequestBody(req)) || "{}");
        const result = await runChatgptWorkOperation(operation, body, undefined, {
          approvalAuthority: options.approvalAuthority,
          principal: options.principal,
          session: options.session,
        });
        sendJson(res, result.state === "conflict" ? 409 : 200, result);
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
          const queuedIndex = queue.findIndex((entry) => entry.jobId === jobId);
          sendJson(res, job ? 200 : 404, {
            found: Boolean(job),
            job: job
              ? {
                  ...job,
                  queuePosition: queuedIndex >= 0 ? queuedIndex : undefined,
                  resultReady: Boolean(job.resultPath),
                }
              : undefined,
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
          const storedJob = await store.readJob(jobId);
          const entry = running.get(jobId) ?? queue.find((item) => item.jobId === jobId);
          if (!entry) {
            sendJson(res, storedJob ? 200 : 404, {
              found: Boolean(storedJob),
              job: storedJob ?? undefined,
            });
            return;
          }
          entry.controller.abort();
          await polling.cancel(jobId);
          const queuedIndex = queue.findIndex((item) => item.jobId === jobId);
          if (queuedIndex >= 0) {
            queue.splice(queuedIndex, 1);
            const queued = await store.readJob(jobId);
            if (queued && queued.status === "queued") {
              await store.transitionJob({
                id: jobId,
                expectedStatus: "queued",
                nextStatus: "cancelled",
                phase: "cancelled",
                message: "Cancelled queued job; queue slot released immediately.",
                outcome: "cancelled",
                reasonCode: "cancelled_queued",
              });
            }
          } else {
            const runningJob = await store.readJob(jobId);
            if (runningJob && runningJob.status !== "cancel_requested") {
              await store.transitionJob({
                id: jobId,
                expectedStatus: runningJob.status,
                nextStatus: "cancel_requested",
                phase: runningJob.phase,
                message:
                  "Cancellation requested; waiting for handler cleanup before releasing the queue slot.",

                outcome: undefined,
                reasonCode: "cancel_requested",
              });
            }
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
            undefined,
            { reasonCode: "artifact_recovery_requested" },
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
          const recoveredJob = await store.readJob(jobId);
          if (recoveredJob) {
            await store.transitionJob({
              id: jobId,
              expectedStatus: recoveredJob.status,
              nextStatus: "completed",
              phase: "completed",
              message: "Job completed through artifact recovery.",
              outcome: "success",
              reasonCode: "artifact_recovered",
            });
          }
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
      const requestTooLarge = error instanceof DaemonRequestTooLargeError;
      const admissionError = error instanceof OracleJobAdmissionError ? error : undefined;
      const idempotencyConflict =
        error instanceof OracleJobIdempotencyConflictError ? error : undefined;
      if (requestTooLarge) res.setHeader("Connection", "close");
      if (admissionError) res.setHeader("Retry-After", String(admissionError.retryAfterSeconds));
      const status =
        admissionError?.statusCode ?? (requestTooLarge ? 413 : idempotencyConflict ? 409 : 500);
      sendJson(res, status, {
        error: requestTooLarge
          ? "request_too_large"
          : idempotencyConflict
            ? "idempotency_conflict"
            : (admissionError?.reason ?? (error instanceof Error ? error.message : String(error))),
        message: error instanceof Error ? error.message : String(error),
        retryAfterSeconds: admissionError?.retryAfterSeconds,
        existingJobId: idempotencyConflict?.existingJobId,
      });
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
    generation: daemonGeneration,
  };
  if (options.connectionPath) {
    await writeConnectionArtifact(options.connectionPath, connection);
  }

  return {
    port: address.port,
    token,
    jobDir: store.rootDir,
    async close() {
      clearInterval(retentionTimer);
      await polling.close();
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

function isTerminalStatus(status: OracleJobStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "unknown" ||
    status === "conflict" ||
    status === "requires_action"
  );
}

function createPollContext(
  store: OracleJobStore,
  jobId: string,
  leaseId: string,
  signal: AbortSignal,
): OracleDaemonJobHandlerContext {
  return {
    jobId,
    signal,
    setPhase: async (phase, message) => {
      const job = await store.readJob(jobId);
      if (!job || signal.aborted || isTerminalStatus(job.status)) return;
      await store.updateJobIfCurrent(
        jobId,
        {
          phase: phase as OracleJobPhase,
          runtime: { ...(job.runtime ?? {}), daemonPid: process.pid },
        },
        { expectedStatus: job.status, expectedOwnerLeaseId: leaseId },
      );
      await store.appendEvent(jobId, "info", phase as OracleJobPhase, message);
    },
    updateRuntime: async (runtime) => {
      const job = await store.readJob(jobId);
      if (!job || signal.aborted || isTerminalStatus(job.status)) return;
      await store.updateJobIfCurrent(
        jobId,
        { runtime: { ...(job.runtime ?? {}), ...runtime } },
        { expectedStatus: job.status, expectedOwnerLeaseId: leaseId },
      );
    },
    markSubmission: async () => {},
    log: async (message, data) => {
      const job = await store.readJob(jobId);
      if (job) await store.appendEvent(jobId, "info", job.phase, message, data);
    },
  };
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
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DAEMON_REQUEST_BYTES) {
    throw new DaemonRequestTooLargeError(
      `Oracle daemon request exceeded ${MAX_DAEMON_REQUEST_BYTES} bytes.`,
    );
  }
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    receivedBytes += buffer.length;
    if (receivedBytes > MAX_DAEMON_REQUEST_BYTES) {
      throw new DaemonRequestTooLargeError(
        `Oracle daemon request exceeded ${MAX_DAEMON_REQUEST_BYTES} bytes.`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, receivedBytes).toString("utf8");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
