import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { requireDaemonClientWithOptionalAutostart } from "../../daemon/resolve.js";

const workState = z.enum([
  "queued",
  "submitted",
  "running",
  "waiting_for_plan_approval",
  "waiting_for_user_input",
  "waiting_for_confirmation",
  "completed",
  "interrupted",
  "requires_action",
  "unsupported",
  "conflict",
]);

const taskShape = {
  taskId: z.string().min(1).optional(),
  task: z.string().optional(),
  deliverable: z.string().optional(),
  deliverables: z.record(z.string(), z.unknown()).optional(),
} satisfies z.ZodRawShape;

const startInputShape = {
  ...taskShape,
  prompt: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
} satisfies z.ZodRawShape;
const identityInputShape = {
  ...taskShape,
  conversationId: z.string().min(1),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
} satisfies z.ZodRawShape;

const workOutputShape = {
  operation: z.enum(["start", "status", "answer", "approve", "interrupt"]),
  state: workState,
  accepted: z.boolean().optional(),
  verified: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  approvalChallenge: z.record(z.string(), z.unknown()).nullable().optional(),
  reason: z.string().optional(),
  conversationId: z.string().nullable().optional(),
  conversationUrl: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  questionId: z.string().nullable().optional(),
  turnId: z.string().nullable().optional(),
  revisionHash: z.string().nullable().optional(),
  plan: z.record(z.string(), z.unknown()).optional(),
  userQuestion: z.record(z.string(), z.unknown()).optional(),
  task: z.string().optional(),
  deliverable: z.string().optional(),
  deliverables: z.record(z.string(), z.unknown()).optional(),
} satisfies z.ZodRawShape;

const startOutputShape = {
  jobId: z.string(),
  kind: z.literal("chatgpt_work_start"),
  status: z.string(),
  phase: z.string(),
  pollTool: z.literal("oracle_job_status"),
  attachTool: z.literal("oracle_job_events"),
  resultTool: z.literal("oracle_job_result"),
  estimatedQueuePosition: z.number(),
} satisfies z.ZodRawShape;

function text(operation: string, result: { state?: string; jobId?: string }): string {
  return result.jobId
    ? `Started ChatGPT Work job ${result.jobId}. Poll oracle_job_status for its durable state.`
    : `ChatGPT Work ${operation} is ${result.state ?? "unknown"}.`;
}

export function registerChatgptWorkTools(server: McpServer): void {
  server.registerTool(
    "chatgpt_work_start",
    {
      title: "Start ChatGPT Work",
      description:
        "Start a durable, attachable ChatGPT Work task without exposing selectors or eval.",
      inputSchema: startInputShape,
      outputSchema: startOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(startInputShape).parse(input);
      const result = await (await requireDaemonClientWithOptionalAutostart()).workStart(parsed);
      return {
        structuredContent: { ...result },
        content: [{ type: "text" as const, text: text("start", result) }],
      };
    },
  );

  const register = (
    name:
      | "chatgpt_work_status"
      | "chatgpt_work_answer"
      | "chatgpt_work_approve"
      | "chatgpt_work_interrupt",
    operation: "status" | "answer" | "approve" | "interrupt",
    inputShape: z.ZodRawShape,
  ) => {
    server.registerTool(
      name,
      {
        title: `ChatGPT Work ${operation}`,
        description: `Run the exact identity-bound ChatGPT Work ${operation} operation.`,
        inputSchema: inputShape,
        outputSchema: workOutputShape,
      },
      async (input: unknown) => {
        const parsed = z.object(inputShape).parse(input);
        const daemon = await requireDaemonClientWithOptionalAutostart();
        const result =
          operation === "status"
            ? await daemon.workStatus(parsed)
            : operation === "answer"
              ? await daemon.workAnswer(parsed)
              : operation === "approve"
                ? await daemon.workApprove(parsed)
                : await daemon.workInterrupt(parsed);
        return {
          structuredContent: { ...result },
          content: [{ type: "text" as const, text: text(operation, result) }],
        };
      },
    );
  };

  register("chatgpt_work_status", "status", identityInputShape);
  register("chatgpt_work_answer", "answer", {
    ...identityInputShape,
    taskId: z.string().min(1),
    questionId: z.string().min(1),
    answer: z.string().min(1),
    turnId: z.string().min(1).optional(),
    expectedRevisionHash: z.string().min(1).optional(),
  });
  register("chatgpt_work_approve", "approve", {
    ...identityInputShape,
    taskId: z.string().min(1),
    expectedRevisionHash: z.string().min(1),
    approvalGrant: z.string().optional(),
    dryRun: z.boolean().optional().default(false),
  });
  register("chatgpt_work_interrupt", "interrupt", {
    ...identityInputShape,
    taskId: z.string().min(1),
    turnId: z.string().min(1),
  });
}
