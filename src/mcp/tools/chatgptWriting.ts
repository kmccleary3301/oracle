import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveTrustedBrowserConfig } from "../../browser/trustedBrowserConfig.js";
import { connectToRemoteChrome, closeRemoteChromeTarget } from "../../browser/chromeLifecycle.js";
import { createRuntimeWritingService } from "../../browser/chatgpt/writing.js";
import type { ApprovalGrantAuthority } from "../../browser/approvalToken.js";
import type { WritingActionResult, WritingOperation } from "../../browser/chatgpt/writingTypes.js";

export interface ChatgptWritingToolDependencies {
  approvalAuthority?: ApprovalGrantAuthority;
  principal?: string;
  session?: string;
}

const approvalChallenge = z.object({
  operation: z.string().min(1),
  target: z.string().min(1),
  revision: z.string().min(1),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  expiry: z.number().int().positive(),
});
const approvalGrant = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const operation = z.enum([
  "writing.get",
  "writing.edit",
  "writing.preview",
  "writing.run",
  "writing.stop",
  "writing.export",
  "codeBlock.list",
  "codeBlock.get",
  "codeBlock.copy",
  "codeBlock.save",
]);

const inputShape = {
  operation,
  conversationUrl: z.string().url().optional(),
  conversationId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  blockId: z.string().min(1).optional(),
  revisionHash: z.string().min(1).optional(),
  content: z.string().optional(),
  runId: z.string().min(1).optional(),
  dryRun: z.boolean().optional().default(false),
  approvalChallenge: approvalChallenge.optional(),
  approvalGrant: approvalGrant.optional(),
  outputPath: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
  keepTab: z.boolean().optional().default(false),
} satisfies z.ZodRawShape;

const blockShape = z.record(z.string(), z.unknown());
const outputShape = {
  status: z.enum([
    "ok",
    "preview",
    "requires_action",
    "unsupported",
    "disconnected",
    "conflict",
    "not_found",
    "stopped",
  ]),
  operation,
  conversationId: z.string().nullable(),
  turnId: z.string().nullable(),
  messageId: z.string().nullable(),
  blockId: z.string().nullable().optional(),
  revisionHash: z.string().nullable(),
  blocks: z.array(blockShape).optional(),
  block: blockShape.nullable().optional(),
  codeBlocks: z.array(blockShape).optional(),
  run: blockShape.nullable().optional(),
  plan: blockShape.optional(),
  artifact: blockShape.optional(),
  dryRun: z.boolean(),
  approvalChallenge: approvalChallenge.nullable(),
  capability: blockShape,
  provenance: blockShape.optional(),
  reason: z.string().optional(),
} satisfies z.ZodRawShape;

const inputSchema = z.object(inputShape);

type ParsedWritingInput = z.infer<typeof inputSchema>;

function text(result: WritingActionResult): string {
  if (result.status === "disconnected") return "ChatGPT writing is disconnected.";
  if (result.status === "requires_action")
    return `ChatGPT writing ${result.operation} requires approval.`;
  if (result.status === "unsupported")
    return `ChatGPT writing ${result.operation} is unsupported by the current UI.`;
  if (result.status === "conflict")
    return `ChatGPT writing ${result.operation} identity or revision conflict.`;
  return `ChatGPT writing ${result.operation} ${result.status}.`;
}

function parseOperationInput(input: ParsedWritingInput): Record<string, unknown> {
  const operation = input.operation as WritingOperation;
  const target = {
    conversationId: input.conversationId,
    turnId: input.turnId,
    messageId: input.messageId,
    blockId: input.blockId,
    revisionHash: input.revisionHash,
  };
  if (["writing.get", "codeBlock.list"].includes(operation))
    return { conversationId: input.conversationId, revisionHash: input.revisionHash };
  if (operation === "writing.edit")
    return {
      ...target,
      content: input.content ?? "",
      dryRun: input.dryRun,
      approvalChallenge: input.approvalChallenge,
      approvalGrant: input.approvalGrant,
    };
  if (operation === "writing.preview") return { ...target, content: input.content };
  if (operation === "writing.run")
    return {
      ...target,
      dryRun: input.dryRun,
      approvalChallenge: input.approvalChallenge,
      approvalGrant: input.approvalGrant,
    };
  if (operation === "writing.stop") return { ...target, runId: input.runId ?? "" };
  if (["writing.export", "codeBlock.save"].includes(operation))
    return {
      ...target,
      dryRun: input.dryRun,
      approvalChallenge: input.approvalChallenge,
      approvalGrant: input.approvalGrant,
      outputPath: input.outputPath,
      mimeType: input.mimeType,
    };
  return target;
}

const resolveMcpBrowserConfig = resolveTrustedBrowserConfig;

async function runWritingOperation(
  input: ParsedWritingInput,
  dependencies: ChatgptWritingToolDependencies,
): Promise<WritingActionResult> {
  const config = await resolveMcpBrowserConfig(input.remoteChrome);
  const remoteChrome = config.remoteChrome;
  if (!remoteChrome) {
    return {
      status: "unsupported",
      operation: input.operation as WritingOperation,
      conversationId: input.conversationId,
      turnId: input.turnId ?? null,
      messageId: input.messageId ?? null,
      blockId: input.blockId ?? null,
      revisionHash: input.revisionHash ?? null,
      dryRun: Boolean(input.dryRun),
      approvalChallenge: null,
      reason: "missing-controls",
      capability: {
        controls: {
          writing: false,
          edit: false,
          preview: false,
          run: false,
          stop: false,
          export: false,
          codeBlock: false,
        },
        supported: false,
        reason: "missing-controls",
      },
    };
  }
  const targetUrl = input.conversationUrl ?? config.chatgptUrl ?? config.url;
  const connection = await connectToRemoteChrome(
    remoteChrome.host,
    remoteChrome.port,
    () => undefined,
    targetUrl,
    undefined,
    { maxTabs: config.remoteChromeMaxTabs },
  );
  try {
    await connection.client.Runtime.enable();
    const service = createRuntimeWritingService({
      Runtime: connection.client.Runtime,
      conversationId: input.conversationId,
      timeoutMs: input.timeoutMs,
      logger: () => undefined,
      approvalAuthority: dependencies.approvalAuthority,
      principal: dependencies.principal,
      session: dependencies.session,
    });
    const operationInput = parseOperationInput(input);
    switch (input.operation) {
      case "writing.get":
        return await service.get(operationInput as never);
      case "writing.edit":
        return await service.edit(operationInput as never);
      case "writing.preview":
        return await service.preview(operationInput as never);
      case "writing.run":
        return await service.run(operationInput as never);
      case "writing.stop":
        return await service.stop(operationInput as never);
      case "writing.export":
        return await service.export(operationInput as never);
      case "codeBlock.list":
        return await service.codeBlockList(operationInput as never);
      case "codeBlock.get":
        return await service.codeBlockGet(operationInput as never);
      case "codeBlock.copy":
        return await service.codeBlockCopy(operationInput as never);
      case "codeBlock.save":
        return await service.codeBlockSave(operationInput as never);
      default:
        throw new Error("unsupported-writing-operation");
    }
  } finally {
    try {
      await connection.client.close();
    } finally {
      if (!input.keepTab)
        await closeRemoteChromeTarget(
          remoteChrome.host,
          remoteChrome.port,
          connection.targetId,
          () => undefined,
        );
    }
  }
}

export function registerChatgptWritingTool(
  server: McpServer,
  dependencies: ChatgptWritingToolDependencies = {},
): void {
  server.registerTool(
    "chatgpt_writing",
    {
      title: "ChatGPT Writing and Code Blocks",
      description:
        "Read and operate on exact ChatGPT writing/code blocks. Identity requires conversationId, turnId, messageId, blockId, and revisionHash for mutations. No selectors or eval are accepted.",
      inputSchema,
      outputSchema: outputShape,
    },
    async (input: unknown) => {
      let parsed: ParsedWritingInput;
      try {
        parsed = inputSchema.parse(input);
      } catch {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Invalid ChatGPT writing input." }],
        };
      }
      try {
        const result = await runWritingOperation(parsed, dependencies);
        const structuredContent = {
          ...result,
          artifact: result.artifact
            ? { ...result.artifact, bytes: Buffer.from(result.artifact.bytes).toString("base64") }
            : undefined,
        };
        return { structuredContent, content: [{ type: "text" as const, text: text(result) }] };
      } catch {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "ChatGPT writing is disconnected." }],
        };
      }
    },
  );
}
