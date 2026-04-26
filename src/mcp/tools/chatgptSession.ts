import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadUserConfig } from "../../config.js";
import { buildBrowserConfig } from "../../cli/browserConfig.js";
import { DEFAULT_MODEL } from "../../oracle.js";
import type { BrowserModelStrategy } from "../../browser/types.js";
import {
  createChatgptSession,
  readChatgptBrowserStatus,
  readChatgptConversationSnapshot,
  sendChatgptTurn,
} from "../../browser/chatgpt/session.js";
import { extractChatgptSandboxArtifactsFromConfiguredBrowser } from "../../browser/chatgpt/sandboxArtifacts.js";
import { resolveBrowserAttachments } from "../../browser/attachmentResolver.js";
import { startMcpJob } from "../jobs.js";
import { resolveDaemonClientWithOptionalAutostart } from "../../daemon/resolve.js";

const browserStatusInputShape = {
  conversationUrl: z.string().url().optional(),
  includeConversation: z.boolean().optional().default(false),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().optional(),
  keepTab: z.boolean().optional().default(false),
} satisfies z.ZodRawShape;

const conversationSnapshotInputShape = {
  conversationUrl: z.string().url(),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().optional(),
  keepTab: z.boolean().optional().default(false),
} satisfies z.ZodRawShape;

const extractSandboxArtifactsInputShape = {
  conversationUrl: z.string().url(),
  outputDir: z.string().optional(),
  download: z.boolean().optional().default(true),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().optional(),
  keepTab: z.boolean().optional().default(false),
} satisfies z.ZodRawShape;

const sendTurnInputShape = {
  conversationUrl: z.string().url(),
  prompt: z.string().min(1),
  files: z.array(z.string()).optional().default([]),
  sandboxArtifactsOutputDir: z.string().optional(),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().optional(),
  browserModelStrategy: z.enum(["select", "current", "ignore"]).optional().default("current"),
  browserModelLabel: z.string().optional(),
  includeSnapshot: z.boolean().optional().default(false),
} satisfies z.ZodRawShape;

const createSessionInputShape = {
  prompt: z.string().min(1),
  files: z.array(z.string()).optional().default([]),
  sandboxArtifactsOutputDir: z.string().optional(),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().optional(),
  browserModelStrategy: z.enum(["select", "current", "ignore"]).optional().default("current"),
  browserModelLabel: z.string().optional(),
  includeSnapshot: z.boolean().optional().default(false),
} satisfies z.ZodRawShape;

const pageShape = z.object({
  href: z.string(),
  title: z.string(),
  readyState: z.string(),
  hasComposer: z.boolean(),
  loginLikely: z.boolean(),
  imageNodeCount: z.number(),
  generatedImageNodeCount: z.number(),
  uniqueGeneratedImageCount: z.number(),
  conversationId: z.string().optional(),
  hasModelMenu: z.boolean().optional(),
  modelMenuLabel: z.string().optional(),
  hasFileUploadControl: z.boolean().optional(),
  hasPhotoUploadControl: z.boolean().optional(),
  hasComposerPlusButton: z.boolean().optional(),
});

const turnShape = z.object({
  index: z.number(),
  role: z.enum(["user", "assistant", "unknown"]),
  turnId: z.string().nullable().optional(),
  messageId: z.string().nullable().optional(),
  text: z.string(),
  textPreview: z.string(),
  generatedImageFileIds: z.array(z.string()),
  attachmentLabels: z.array(z.string()),
  sandboxArtifactLabels: z.array(z.string()),
});

const sandboxArtifactRefShape = z.object({
  label: z.string(),
  turnIndex: z.number(),
  turnId: z.string().nullable().optional(),
  messageId: z.string().nullable().optional(),
  documentIndex: z.number(),
});

const downloadedSandboxArtifactShape = z.object({
  label: z.string(),
  turnIndex: z.number(),
  turnId: z.string().nullable().optional(),
  messageId: z.string().nullable().optional(),
  documentIndex: z.number(),
  sandboxPath: z.string().optional(),
  fileId: z.string().optional(),
  fileName: z.string(),
  downloadedPath: z.string(),
  mimeType: z.string().optional(),
  byteSize: z.number(),
  sha256: z.string(),
  downloadMethod: z.literal("browser-fetch"),
});

const generatedImageShape = z.object({
  fileId: z.string(),
  sourceUrl: z.string(),
  turnId: z.string().nullable().optional(),
  messageId: z.string().nullable().optional(),
  turnIndex: z.number().nullable().optional(),
  variantIndex: z.number(),
  renderedWidth: z.number(),
  renderedHeight: z.number(),
  isThumbnail: z.boolean(),
  duplicateNodeCount: z.number(),
});

const conversationSnapshotOutputShape = {
  page: pageShape,
  turns: z.array(turnShape),
  generatedImages: z.array(generatedImageShape),
  sandboxArtifacts: z.array(sandboxArtifactRefShape),
  latestAssistantTurn: turnShape.optional(),
  latestUserTurn: turnShape.optional(),
  warnings: z.array(z.string()),
} satisfies z.ZodRawShape;

const browserStatusOutputShape = {
  remoteChrome: z.object({ host: z.string(), port: z.number() }),
  page: pageShape,
  status: z.enum(["ok", "needs_login", "unavailable"]),
  conversation: z.object(conversationSnapshotOutputShape).optional(),
  warnings: z.array(z.string()),
} satisfies z.ZodRawShape;

const sendTurnOutputShape = {
  status: z.literal("completed"),
  conversationUrl: z.string().optional(),
  answerText: z.string(),
  answerMarkdown: z.string(),
  tookMs: z.number(),
  answerChars: z.number(),
  answerTokens: z.number(),
  chromeHost: z.string().optional(),
  chromePort: z.number().optional(),
  chromeTargetId: z.string().optional(),
  snapshot: z.object(conversationSnapshotOutputShape).optional(),
  generatedImages: z.array(generatedImageShape).optional(),
  newGeneratedImages: z.array(generatedImageShape).optional(),
  sandboxArtifacts: z.array(sandboxArtifactRefShape).optional(),
  newSandboxArtifacts: z.array(sandboxArtifactRefShape).optional(),
  downloadedSandboxArtifacts: z.array(downloadedSandboxArtifactShape).optional(),
  warnings: z.array(z.string()),
} satisfies z.ZodRawShape;

const extractSandboxArtifactsOutputShape = {
  conversationUrl: z.string(),
  outputDir: z.string().optional(),
  sandboxArtifacts: z.array(sandboxArtifactRefShape),
  downloadedArtifacts: z.array(downloadedSandboxArtifactShape),
  warnings: z.array(z.string()),
} satisfies z.ZodRawShape;

const createSessionInputSchema = z.object(createSessionInputShape);
const sendTurnInputSchema = z.object(sendTurnInputShape);

const asyncJobStartOutputShape = {
  jobId: z.string(),
  kind: z.string(),
  status: z.string(),
  phase: z.string().optional(),
  startedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  attachTool: z.literal("oracle_job_events").optional(),
  resultTool: z.literal("oracle_job_result").optional(),
  pollTool: z.literal("oracle_job_status"),
} satisfies z.ZodRawShape;

export function registerChatgptSessionTools(server: McpServer): void {
  server.registerTool(
    "chatgpt_create_session_async",
    {
      title: "Start async ChatGPT conversation",
      description:
        "Start a long-running ChatGPT conversation turn and return immediately with a job id. Poll oracle_job_status to collect the completed text, images, and sandbox artifacts.",
      inputSchema: createSessionInputShape,
      outputSchema: asyncJobStartOutputShape,
    },
    async (input: unknown) => {
      const parsed = createSessionInputSchema.parse(input);
      const daemonJob = await maybeStartDaemonJob("chatgpt_create_session", parsed);
      if (daemonJob) {
        const structuredContent = { ...daemonJob };
        return {
          structuredContent,
          content: [
            {
              type: "text" as const,
              text: `Started daemon-backed ChatGPT create-session job ${daemonJob.jobId}. Poll oracle_job_status with this jobId.`,
            },
          ],
        };
      }
      const job = startMcpJob("chatgpt_create_session", () => runCreateSession(parsed));
      const structuredContent = {
        jobId: job.id,
        kind: job.kind,
        status: job.status,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        pollTool: "oracle_job_status" as const,
      };
      return {
        structuredContent,
        content: [
          {
            type: "text" as const,
            text: `Started ChatGPT create-session job ${job.id}. Poll oracle_job_status with this jobId.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "chatgpt_create_session",
    {
      title: "Create ChatGPT conversation",
      description:
        "Create a new ChatGPT conversation by sending an initial prompt through the logged-in browser. Defaults to the current model/mode.",
      inputSchema: createSessionInputShape,
      outputSchema: sendTurnOutputShape,
    },
    async (input: unknown) => {
      const parsed = createSessionInputSchema.parse(input);
      const structuredContent = await runCreateSession(parsed);
      return {
        structuredContent,
        content: [
          {
            type: "text" as const,
            text: `${structuredContent.conversationUrl ?? "Conversation created"}\n${structuredContent.answerMarkdown || structuredContent.answerText}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "chatgpt_browser_status",
    {
      title: "Check ChatGPT browser status",
      description:
        "Attach to the configured logged-in ChatGPT browser and report login/composer/page state.",
      inputSchema: browserStatusInputShape,
      outputSchema: browserStatusOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(browserStatusInputShape).parse(input);
      const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
      const structuredContent = await readChatgptBrowserStatus({
        conversationUrl: parsed.conversationUrl,
        includeConversation: parsed.includeConversation,
        timeoutMs: parsed.timeoutMs,
        keepTab: parsed.keepTab,
        config,
      });
      return {
        structuredContent: { ...structuredContent },
        content: [
          {
            type: "text" as const,
            text: `ChatGPT browser status: ${structuredContent.status} (${structuredContent.page.href})`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "chatgpt_get_conversation",
    {
      title: "Read ChatGPT conversation",
      description:
        "Read a ChatGPT conversation snapshot from the logged-in browser, including turns and generated image references.",
      inputSchema: conversationSnapshotInputShape,
      outputSchema: conversationSnapshotOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(conversationSnapshotInputShape).parse(input);
      const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
      const result = await readChatgptConversationSnapshot({
        conversationUrl: parsed.conversationUrl,
        timeoutMs: parsed.timeoutMs,
        keepTab: parsed.keepTab,
        config,
      });
      const structuredContent = {
        ...result,
        generatedImages: result.generatedImages.map(
          ({ domRecords: _domRecords, ...image }) => image,
        ),
      };
      return {
        structuredContent,
        content: [
          {
            type: "text" as const,
            text: `Read ${result.turns.length} turn(s) from ${result.page.href}.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "chatgpt_extract_sandbox_artifacts",
    {
      title: "Extract ChatGPT sandbox artifacts",
      description:
        "Read an existing ChatGPT conversation in the logged-in browser, resolve assistant sandbox download buttons, and optionally download every emitted file artifact.",
      inputSchema: extractSandboxArtifactsInputShape,
      outputSchema: extractSandboxArtifactsOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(extractSandboxArtifactsInputShape).parse(input);
      const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
      const result = await extractChatgptSandboxArtifactsFromConfiguredBrowser({
        conversationUrl: parsed.conversationUrl,
        outputDir: parsed.outputDir,
        download: parsed.download,
        timeoutMs: parsed.timeoutMs,
        keepTab: parsed.keepTab,
        config,
      });
      const structuredContent = {
        conversationUrl: result.page.href,
        outputDir: result.outputDir,
        sandboxArtifacts: result.sandboxArtifacts,
        downloadedArtifacts: result.downloadedArtifacts,
        warnings: result.warnings,
      };
      return {
        structuredContent,
        content: [
          {
            type: "text" as const,
            text: `Resolved ${result.sandboxArtifacts.length} sandbox artifact button(s) from ${result.page.href}.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "chatgpt_send_turn_async",
    {
      title: "Start async ChatGPT conversation turn",
      description:
        "Start a long-running turn on an existing ChatGPT conversation and return immediately with a job id. Poll oracle_job_status to collect the completed result.",
      inputSchema: sendTurnInputShape,
      outputSchema: asyncJobStartOutputShape,
    },
    async (input: unknown) => {
      const parsed = sendTurnInputSchema.parse(input);
      const daemonJob = await maybeStartDaemonJob("chatgpt_send_turn", parsed);
      if (daemonJob) {
        const structuredContent = { ...daemonJob };
        return {
          structuredContent,
          content: [
            {
              type: "text" as const,
              text: `Started daemon-backed ChatGPT send-turn job ${daemonJob.jobId}. Poll oracle_job_status with this jobId.`,
            },
          ],
        };
      }
      const job = startMcpJob("chatgpt_send_turn", () => runSendTurn(parsed));
      const structuredContent = {
        jobId: job.id,
        kind: job.kind,
        status: job.status,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        pollTool: "oracle_job_status" as const,
      };
      return {
        structuredContent,
        content: [
          {
            type: "text" as const,
            text: `Started ChatGPT send-turn job ${job.id}. Poll oracle_job_status with this jobId.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "chatgpt_send_turn",
    {
      title: "Send ChatGPT conversation turn",
      description:
        "Append one prompt turn to an existing ChatGPT conversation through the logged-in browser. Defaults to the current model/mode.",
      inputSchema: sendTurnInputShape,
      outputSchema: sendTurnOutputShape,
    },
    async (input: unknown) => {
      const parsed = sendTurnInputSchema.parse(input);
      const serialized = await runSendTurn(parsed);
      return {
        structuredContent: serialized,
        content: [
          {
            type: "text" as const,
            text: serialized.answerMarkdown || serialized.answerText,
          },
        ],
      };
    },
  );
}

async function runCreateSession(parsed: z.infer<typeof createSessionInputSchema>) {
  const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
  const attachments = await resolveBrowserAttachments(parsed.files ?? []);
  const result = await createChatgptSession({
    prompt: parsed.prompt,
    attachments,
    timeoutMs: parsed.timeoutMs,
    includeSnapshot: parsed.includeSnapshot,
    config: {
      ...config,
      modelStrategy: parsed.browserModelStrategy as BrowserModelStrategy,
      desiredModel: parsed.browserModelLabel ?? config.desiredModel,
      sandboxArtifactsOutputDir:
        parsed.sandboxArtifactsOutputDir ?? config.sandboxArtifactsOutputDir,
    },
  });
  return serializeTurnResult(result);
}

async function runSendTurn(parsed: z.infer<typeof sendTurnInputSchema>) {
  const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
  const attachments = await resolveBrowserAttachments(parsed.files ?? []);
  const result = await sendChatgptTurn({
    conversationUrl: parsed.conversationUrl,
    prompt: parsed.prompt,
    attachments,
    timeoutMs: parsed.timeoutMs,
    includeSnapshot: parsed.includeSnapshot,
    config: {
      ...config,
      modelStrategy: parsed.browserModelStrategy as BrowserModelStrategy,
      desiredModel: parsed.browserModelLabel ?? config.desiredModel,
      sandboxArtifactsOutputDir:
        parsed.sandboxArtifactsOutputDir ?? config.sandboxArtifactsOutputDir,
    },
  });
  return serializeTurnResult(result);
}

async function resolveMcpBrowserConfig(remoteChrome?: string) {
  const { config: userConfig } = await loadUserConfig();
  const cliBrowserConfig = remoteChrome
    ? await buildBrowserConfig({ model: DEFAULT_MODEL, remoteChrome })
    : {};
  return {
    ...(userConfig.browser ?? {}),
    ...cliBrowserConfig,
    remoteChrome: cliBrowserConfig.remoteChrome ?? userConfig.browser?.remoteChrome ?? null,
  };
}

function serializeTurnResult(result: Awaited<ReturnType<typeof sendChatgptTurn>>) {
  return {
    ...result,
    snapshot: result.snapshot
      ? {
          ...result.snapshot,
          generatedImages: result.snapshot.generatedImages.map(
            ({ domRecords: _domRecords, ...image }) => image,
          ),
        }
      : undefined,
    generatedImages: result.generatedImages?.map(({ domRecords: _domRecords, ...image }) => image),
    newGeneratedImages: result.newGeneratedImages?.map(
      ({ domRecords: _domRecords, ...image }) => image,
    ),
  };
}

async function maybeStartDaemonJob(
  kind: "chatgpt_create_session" | "chatgpt_send_turn",
  input: unknown,
) {
  const daemon = await resolveDaemonClientWithOptionalAutostart();
  if (!daemon) return null;
  return await daemon.startJob({ kind, input });
}
