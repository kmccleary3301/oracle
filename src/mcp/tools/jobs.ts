import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMcpJob, listMcpJobs } from "../jobs.js";
import { resolveDaemonClientWithOptionalAutostart } from "../../daemon/resolve.js";

const jobStatusInputShape = {
  jobId: z.string().min(1).describe("Job id returned by an async Oracle MCP tool."),
} satisfies z.ZodRawShape;

const jobListInputShape = {
  limit: z.number().optional().default(20),
} satisfies z.ZodRawShape;

const jobEventsInputShape = {
  jobId: z.string().min(1).describe("Job id returned by an async Oracle MCP tool."),
  after: z
    .number()
    .optional()
    .default(0)
    .describe("Only return events with seq greater than this value."),
} satisfies z.ZodRawShape;

const jobCancelInputShape = {
  jobId: z.string().min(1).describe("Job id returned by an async Oracle MCP tool."),
} satisfies z.ZodRawShape;

const jobRecoverInputShape = {
  jobId: z.string().min(1).describe("Job id returned by an async Oracle MCP tool."),
  conversationUrl: z
    .string()
    .url()
    .optional()
    .describe("Optional explicit ChatGPT conversation URL to recover from."),
  outputDir: z.string().optional().describe("Optional output directory for recovered artifacts."),
  remoteChrome: z.string().optional().describe("Optional Chrome DevTools endpoint host:port."),
  download: z.boolean().optional().default(true),
  artifactTypes: z
    .array(z.enum(["images", "sandbox"]))
    .optional()
    .default(["images", "sandbox"]),
  keepTab: z.boolean().optional().default(false),
  timeoutMs: z.number().optional(),
} satisfies z.ZodRawShape;

const jobRecordShape = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  phase: z.string().optional(),
  startedAt: z.string().optional(),
  updatedAt: z.string(),
  createdAt: z.string().optional(),
  completedAt: z.string().optional(),
  resultReady: z.boolean().optional(),
  result: z.unknown().optional(),
  resultSummary: z.unknown().optional(),
  error: z.string().optional(),
  errorDetail: z.unknown().optional(),
});

const jobStatusOutputShape = {
  found: z.boolean(),
  job: jobRecordShape.optional(),
} satisfies z.ZodRawShape;

const jobListOutputShape = {
  jobs: z.array(jobRecordShape),
} satisfies z.ZodRawShape;

const jobEventsOutputShape = {
  found: z.boolean(),
  events: z.array(z.unknown()),
} satisfies z.ZodRawShape;

const jobResultOutputShape = {
  found: z.boolean(),
  ready: z.boolean(),
  job: z.unknown().optional(),
  result: z.unknown().optional(),
} satisfies z.ZodRawShape;

const daemonStatusOutputShape = {
  available: z.boolean(),
  status: z.unknown().optional(),
  warning: z.string().optional(),
} satisfies z.ZodRawShape;

export function registerMcpJobTools(server: McpServer): void {
  server.registerTool(
    "oracle_job_status",
    {
      title: "Check Oracle async job status",
      description:
        "Poll a long-running Oracle MCP job started by an async ChatGPT/Images tool. Completed jobs include the same structured result the synchronous tool would return.",
      inputSchema: jobStatusInputShape,
      outputSchema: jobStatusOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(jobStatusInputShape).parse(input);
      const daemon = await resolveDaemonClient();
      if (daemon) {
        const response = (await daemon.jobStatus(parsed.jobId)) as {
          found?: boolean;
          job?: Record<string, unknown> & { id?: string; status?: string };
        };
        const structuredContent = {
          ...response,
          job: response.job ? normalizeJobRecordForMcp(response.job) : undefined,
        };
        return {
          structuredContent,
          content: [
            {
              type: "text" as const,
              text: structuredContent.job
                ? `Oracle job ${structuredContent.job.id} is ${structuredContent.job.status}.`
                : `Oracle job ${parsed.jobId} was not found.`,
            },
          ],
        };
      }
      const job = getMcpJob(parsed.jobId);
      const structuredContent = {
        found: Boolean(job),
        job,
      };
      return {
        structuredContent,
        content: [
          {
            type: "text" as const,
            text: job
              ? `Oracle job ${job.id} is ${job.status}.`
              : `Oracle job ${parsed.jobId} was not found in this MCP server process.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "oracle_jobs",
    {
      title: "List Oracle async jobs",
      description: "List recent long-running Oracle MCP jobs in this MCP server process.",
      inputSchema: jobListInputShape,
      outputSchema: jobListOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(jobListInputShape).parse(input);
      const daemon = await resolveDaemonClient();
      if (daemon) {
        const response = (await daemon.listJobs(parsed.limit)) as { jobs?: unknown[] };
        const structuredContent = {
          jobs: (response.jobs ?? []).map((job) => normalizeJobRecordForMcp(job)),
        };
        return {
          structuredContent,
          content: [
            {
              type: "text" as const,
              text: `Listed ${structuredContent.jobs.length} Oracle daemon job(s).`,
            },
          ],
        };
      }
      const structuredContent = {
        jobs: listMcpJobs(parsed.limit).map((job) => normalizeJobRecordForMcp(job)),
      };
      return {
        structuredContent,
        content: [
          {
            type: "text" as const,
            text: `Listed ${structuredContent.jobs.length} Oracle async job(s).`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "oracle_job_events",
    {
      title: "Read Oracle async job events",
      description: "Read incremental event log entries for a daemon-backed Oracle async job.",
      inputSchema: jobEventsInputShape,
      outputSchema: jobEventsOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(jobEventsInputShape).parse(input);
      const daemon = await requireDaemonClient();
      const structuredContent = (await daemon.jobEvents(parsed.jobId, parsed.after)) as {
        events?: unknown[];
      };
      return {
        structuredContent,
        content: [
          {
            type: "text" as const,
            text: `Read ${structuredContent.events?.length ?? 0} event(s) for Oracle job ${parsed.jobId}.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "oracle_job_result",
    {
      title: "Read Oracle async job result",
      description:
        "Read the full result payload for a daemon-backed Oracle async job after completion.",
      inputSchema: jobStatusInputShape,
      outputSchema: jobResultOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(jobStatusInputShape).parse(input);
      const daemon = await requireDaemonClient();
      const structuredContent = (await daemon.jobResult(parsed.jobId)) as {
        found?: boolean;
        ready?: boolean;
      };
      return {
        structuredContent,
        content: [
          {
            type: "text" as const,
            text: structuredContent.ready
              ? `Oracle job ${parsed.jobId} result is ready.`
              : `Oracle job ${parsed.jobId} result is not ready.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "oracle_job_cancel",
    {
      title: "Cancel Oracle async job",
      description: "Request cancellation for a daemon-backed Oracle async job.",
      inputSchema: jobCancelInputShape,
      outputSchema: jobStatusOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(jobCancelInputShape).parse(input);
      const daemon = await requireDaemonClient();
      const response = (await daemon.cancelJob(parsed.jobId)) as {
        found?: boolean;
        job?: Record<string, unknown> & { id?: string; status?: string };
      };
      const structuredContent = {
        ...response,
        job: response.job ? normalizeJobRecordForMcp(response.job) : undefined,
      };
      return {
        structuredContent,
        content: [
          {
            type: "text" as const,
            text: structuredContent.job
              ? `Oracle job ${structuredContent.job.id} is ${structuredContent.job.status}.`
              : `Oracle job ${parsed.jobId} was not found.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "oracle_job_recover",
    {
      title: "Recover Oracle async job artifacts",
      description:
        "Recover a stale daemon job by extracting completed ChatGPT image and/or sandbox artifacts from its recorded conversation URL or an active browser tab.",
      inputSchema: jobRecoverInputShape,
      outputSchema: {
        found: z.boolean(),
        recovered: z.boolean().optional(),
        job: jobRecordShape.optional(),
        result: z.unknown().optional(),
      },
    },
    async (input: unknown) => {
      const parsed = z.object(jobRecoverInputShape).parse(input);
      const daemon = await requireDaemonClient();
      const response = (await daemon.recoverJob(parsed.jobId, {
        conversationUrl: parsed.conversationUrl,
        outputDir: parsed.outputDir,
        remoteChrome: parsed.remoteChrome,
        download: parsed.download,
        artifactTypes: parsed.artifactTypes,
        keepTab: parsed.keepTab,
        timeoutMs: parsed.timeoutMs,
      })) as {
        found?: boolean;
        recovered?: boolean;
        job?: Record<string, unknown> & { id?: string; status?: string };
        result?: unknown;
      };
      const structuredContent = {
        ...response,
        job: response.job ? normalizeJobRecordForMcp(response.job) : undefined,
      };
      return {
        structuredContent,
        content: [
          {
            type: "text" as const,
            text: structuredContent.recovered
              ? `Recovered artifacts for Oracle job ${parsed.jobId}.`
              : `Oracle job ${parsed.jobId} could not be recovered.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "oracle_daemon_status",
    {
      title: "Check Oracle daemon status",
      description:
        "Check whether this MCP server can reach the configured daemon-backed async job service.",
      inputSchema: {},
      outputSchema: daemonStatusOutputShape,
    },
    async () => {
      const daemon = await resolveDaemonClient();
      if (!daemon) {
        const structuredContent = {
          available: false,
          warning: "No Oracle daemon connection artifact is configured or readable.",
        };
        return {
          structuredContent,
          content: [{ type: "text" as const, text: structuredContent.warning }],
        };
      }
      const status = await daemon.status();
      const structuredContent = { available: true, status };
      return {
        structuredContent,
        content: [{ type: "text" as const, text: "Oracle daemon is reachable." }],
      };
    },
  );
}

async function resolveDaemonClient() {
  return await resolveDaemonClientWithOptionalAutostart();
}

async function requireDaemonClient() {
  const daemon = await resolveDaemonClient();
  if (!daemon) {
    throw new Error(
      "Oracle daemon is not configured. Start `oracle daemon start --background` or set ORACLE_DAEMON_CONNECTION.",
    );
  }
  return daemon;
}

function normalizeJobRecordForMcp(job: unknown): Record<string, unknown> {
  if (!job || typeof job !== "object") return {};
  const record = { ...(job as Record<string, unknown>) };
  const error = record.error;
  if (error && typeof error !== "string") {
    record.errorDetail = error;
    if (typeof error === "object" && "message" in error) {
      record.error = String((error as { message?: unknown }).message);
    } else {
      record.error = JSON.stringify(error);
    }
  }
  return record;
}
