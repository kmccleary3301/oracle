import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OracleDaemonJobStartResponse } from "../../daemon/types.js";
import { startMcpJob } from "../jobs.js";
import type { OracleJobKind } from "../../jobs/types.js";

const startShape = {
  prompt: z.string().min(1),
  conversationUrl: z.string().url().optional(),
  conversationId: z.string().optional(),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
  sourceAllowlist: z
    .object({
      sites: z.array(z.string().min(1)).optional().default([]),
      apps: z.array(z.string().min(1)).optional().default([]),
    })
    .optional(),
} satisfies z.ZodRawShape;
const approvalChallenge = z.object({
  operation: z.string().min(1),
  target: z.string().min(1),
  revision: z.string().min(1),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  expiry: z.number().int().positive(),
});
const planShape = {
  conversationUrl: z.string().url(),
  conversationId: z.string().min(1),
  remoteChrome: z.string().optional(),
  dryRun: z.boolean().optional().default(true),
  approve: z.boolean().optional().default(false),
  approvalChallenge: approvalChallenge.optional(),
  approvalGrant: z.string().optional(),
  expectedRevisionHash: z.string().optional(),
  edits: z
    .object({
      summary: z.string().optional(),
      action: z.string().optional(),
      sites: z.array(z.string()).optional(),
      apps: z.array(z.string()).optional(),
    })
    .optional(),
} satisfies z.ZodRawShape;
const getShape = {
  conversationUrl: z.string().url(),
  conversationId: z.string().min(1),
  remoteChrome: z.string().optional(),
  wait: z.boolean().optional().default(false),
  timeoutMs: z.number().positive().optional(),
} satisfies z.ZodRawShape;
const interruptShape = {
  conversationUrl: z.string().url(),
  conversationId: z.string().min(1),
  remoteChrome: z.string().optional(),
  turnId: z.string().optional(),
} satisfies z.ZodRawShape;
const downloadShape = {
  reportMarkdown: z.string().min(1),
  outputDir: z.string().min(1),
  formats: z.array(z.enum(["markdown", "docx", "pdf"])).optional(),
  conversationUrl: z.string().url().optional(),
  conversationId: z.string().optional(),
  turnId: z.string().optional(),
  messageId: z.string().optional(),
} satisfies z.ZodRawShape;
const startOutput = {
  jobId: z.string(),
  kind: z.string(),
  status: z.string(),
  phase: z.string().optional(),
  pollTool: z.literal("oracle_job_status"),
  attachTool: z.literal("oracle_job_events"),
  resultTool: z.literal("oracle_job_result"),
} satisfies z.ZodRawShape;

async function startResearchJob(
  kind: OracleJobKind,
  input: unknown,
): Promise<OracleDaemonJobStartResponse> {
  return await startMcpJob(kind, input);
}
function response(job: OracleDaemonJobStartResponse, label: string) {
  return {
    structuredContent: { ...job },
    content: [
      {
        type: "text" as const,
        text: `${label} durable job ${job.jobId} started; poll oracle_job_status.`,
      },
    ],
  };
}

export function registerChatgptResearchTools(server: McpServer): void {
  server.registerTool(
    "chatgpt_research_start",
    {
      title: "Start Deep Research",
      description: "Start a durable Deep Research operation with optional site and app allowlists.",
      inputSchema: startShape,
      outputSchema: startOutput,
    },
    async (input: unknown) =>
      response(
        await startResearchJob("chatgpt_research_start", z.object(startShape).parse(input)),
        "Deep Research start",
      ),
  );
  server.registerTool(
    "chatgpt_research_plan",
    {
      title: "Plan Deep Research",
      description:
        "Capture or dry-run edit/approval of a Deep Research plan. Unknown or consequential plans remain requires_action.",
      inputSchema: planShape,
      outputSchema: startOutput,
    },
    async (input: unknown) =>
      response(
        await startResearchJob("chatgpt_research_plan", z.object(planShape).parse(input)),
        "Deep Research plan",
      ),
  );
  server.registerTool(
    "chatgpt_research_get",
    {
      title: "Get Deep Research",
      description: "Read durable Deep Research progress or wait for the cited answer.",
      inputSchema: getShape,
      outputSchema: startOutput,
    },
    async (input: unknown) =>
      response(
        await startResearchJob("chatgpt_research_get", z.object(getShape).parse(input)),
        "Deep Research get",
      ),
  );
  server.registerTool(
    "chatgpt_research_interrupt",
    {
      title: "Interrupt Deep Research",
      description:
        "Interrupt only the matching conversation and turn, with post-click verification.",
      inputSchema: interruptShape,
      outputSchema: startOutput,
    },
    async (input: unknown) =>
      response(
        await startResearchJob("chatgpt_research_interrupt", z.object(interruptShape).parse(input)),
        "Deep Research interrupt",
      ),
  );
  server.registerTool(
    "chatgpt_research_download",
    {
      title: "Download Deep Research",
      description:
        "Write Markdown, DOCX, and PDF report artifacts with byte sizes and SHA-256 hashes.",
      inputSchema: downloadShape,
      outputSchema: startOutput,
    },
    async (input: unknown) =>
      response(
        await startResearchJob("chatgpt_research_download", z.object(downloadShape).parse(input)),
        "Deep Research download",
      ),
  );
}
