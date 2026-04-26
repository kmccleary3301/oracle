import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadUserConfig } from "../../config.js";
import { buildBrowserConfig } from "../../cli/browserConfig.js";
import { DEFAULT_MODEL } from "../../oracle.js";
import { extractChatgptImagesFromConfiguredBrowser } from "../../browser/chatgpt/imageArtifacts.js";
import { extractChatgptSandboxArtifactsFromConfiguredBrowser } from "../../browser/chatgpt/sandboxArtifacts.js";
import { createChatgptSession } from "../../browser/chatgpt/session.js";
import { resolveBrowserAttachments } from "../../browser/attachmentResolver.js";
import type { BrowserModelStrategy } from "../../browser/types.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";
import { startMcpJob } from "../jobs.js";
import { resolveDaemonClientWithOptionalAutostart } from "../../daemon/resolve.js";

const DEFAULT_CHATGPT_IMAGE_TURN_TIMEOUT_MS = 30 * 60_000;

const extractImagesInputShape = {
  conversationUrl: z
    .string()
    .url()
    .describe("ChatGPT conversation URL, for example https://chatgpt.com/c/<id>."),
  outputDir: z
    .string()
    .optional()
    .describe("Optional directory for downloaded images and JSON sidecars."),
  download: z
    .boolean()
    .optional()
    .default(true)
    .describe("Download image bytes through the logged-in browser context."),
  remoteChrome: z
    .string()
    .optional()
    .describe("Optional Chrome DevTools endpoint override, formatted host:port."),
  timeoutMs: z.number().optional().describe("Read-only extraction timeout in milliseconds."),
  keepTab: z.boolean().optional().default(false).describe("Leave the opened browser tab alive."),
} satisfies z.ZodRawShape;

const generateImagesInputShape = {
  prompt: z.string().min(1).describe("Image-generation prompt text to send."),
  files: z.array(z.string()).optional().default([]).describe("Optional file paths to attach."),
  projectUrl: z.string().url().optional().describe("Optional ChatGPT project URL to start from."),
  outputDir: z
    .string()
    .optional()
    .describe("Optional directory for downloaded images and JSON sidecars."),
  download: z
    .boolean()
    .optional()
    .default(true)
    .describe("Download generated image bytes after the turn completes."),
  remoteChrome: z
    .string()
    .optional()
    .describe("Optional Chrome DevTools endpoint override, formatted host:port."),
  timeoutMs: z.number().optional().describe("Generation timeout in milliseconds."),
  extractionTimeoutMs: z
    .number()
    .optional()
    .describe("Post-turn artifact extraction timeout in milliseconds."),
  browserModelStrategy: z.enum(["select", "current", "ignore"]).optional().default("current"),
  browserModelLabel: z
    .string()
    .optional()
    .describe("Exact/fuzzy ChatGPT model picker label to use."),
  browserThinkingTime: z
    .enum(["light", "standard", "extended", "heavy"])
    .optional()
    .describe("Thinking time intensity for image generation."),
  thinkingFallback: z
    .enum(["allow", "fail"])
    .optional()
    .default("allow")
    .describe("Whether missing Thinking controls should continue or fail the turn."),
  artifactTypes: z
    .array(z.enum(["images", "sandbox"]))
    .optional()
    .default(["images"]),
} satisfies z.ZodRawShape;

const editImageInputShape = {
  prompt: z.string().min(1).describe("Image-editing prompt text to send."),
  files: z
    .array(z.string())
    .min(1)
    .describe("Image files, zips, directories, or globs to attach as edit references."),
  projectUrl: z.string().url().optional().describe("Optional ChatGPT project URL to start from."),
  outputDir: z
    .string()
    .optional()
    .describe("Optional directory for downloaded images and JSON sidecars."),
  download: z
    .boolean()
    .optional()
    .default(true)
    .describe("Download generated image bytes after the turn completes."),
  remoteChrome: z
    .string()
    .optional()
    .describe("Optional Chrome DevTools endpoint override, formatted host:port."),
  timeoutMs: z.number().optional().describe("Edit timeout in milliseconds."),
  extractionTimeoutMs: z
    .number()
    .optional()
    .describe("Post-turn artifact extraction timeout in milliseconds."),
  browserModelStrategy: z.enum(["select", "current", "ignore"]).optional().default("current"),
  browserModelLabel: z
    .string()
    .optional()
    .describe("Exact/fuzzy ChatGPT model picker label to use."),
  browserThinkingTime: z
    .enum(["light", "standard", "extended", "heavy"])
    .optional()
    .describe("Thinking time intensity for image editing."),
  thinkingFallback: z
    .enum(["allow", "fail"])
    .optional()
    .default("allow")
    .describe("Whether missing Thinking controls should continue or fail the turn."),
  artifactTypes: z
    .array(z.enum(["images", "sandbox"]))
    .optional()
    .default(["images"]),
} satisfies z.ZodRawShape;

const imageArtifactShape = z.object({
  fileId: z.string(),
  sourceUrl: z.string(),
  downloadedPath: z.string(),
  mimeType: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  byteSize: z.number(),
  sha256: z.string(),
  variantIndex: z.number(),
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

const extractImagesOutputShape = {
  conversationUrl: z.string(),
  uniqueGeneratedImageCount: z.number(),
  generatedImageNodeCount: z.number(),
  outputDir: z.string().optional(),
  images: z.array(generatedImageShape),
  artifacts: z.array(imageArtifactShape),
  sandboxArtifacts: z.array(z.unknown()).optional(),
  downloadedArtifacts: z.array(z.unknown()).optional(),
  thinkingTimeSelection: z.unknown().optional(),
  warnings: z.array(z.string()),
} satisfies z.ZodRawShape;

const generateImagesOutputShape = {
  conversationUrl: z.string().optional(),
  answerText: z.string(),
  answerMarkdown: z.string(),
  tookMs: z.number(),
  newGeneratedImageCount: z.number(),
  uniqueGeneratedImageCount: z.number(),
  generatedImageNodeCount: z.number(),
  outputDir: z.string().optional(),
  images: z.array(generatedImageShape),
  artifacts: z.array(imageArtifactShape),
  warnings: z.array(z.string()),
} satisfies z.ZodRawShape;

const editImageOutputShape = {
  ...generateImagesOutputShape,
  inputAttachments: z.array(
    z.object({
      path: z.string(),
      displayPath: z.string(),
      sizeBytes: z.number().optional(),
    }),
  ),
} satisfies z.ZodRawShape;

const generateImagesInputSchema = z.object(generateImagesInputShape);
const editImageInputSchema = z.object(editImageInputShape);

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

export function registerChatgptImagesTool(server: McpServer): void {
  server.registerTool(
    "chatgpt_extract_images",
    {
      title: "Extract ChatGPT generated images",
      description:
        "Read an existing ChatGPT conversation in the logged-in browser, dedupe generated image outputs by file id, and optionally download every image artifact.",
      inputSchema: extractImagesInputShape,
      outputSchema: extractImagesOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(extractImagesInputShape).parse(input);
      const { config: userConfig } = await loadUserConfig();
      const cliBrowserConfig = parsed.remoteChrome
        ? await buildBrowserConfig({ model: DEFAULT_MODEL, remoteChrome: parsed.remoteChrome })
        : {};
      const result = await extractChatgptImagesFromConfiguredBrowser({
        conversationUrl: parsed.conversationUrl,
        outputDir: parsed.outputDir,
        download: parsed.download,
        timeoutMs: parsed.timeoutMs,
        keepTab: parsed.keepTab,
        config: {
          ...(userConfig.browser ?? {}),
          ...cliBrowserConfig,
          remoteChrome: cliBrowserConfig.remoteChrome ?? userConfig.browser?.remoteChrome ?? null,
        },
      });
      const structuredContent = {
        conversationUrl: result.page.href,
        uniqueGeneratedImageCount: result.images.length,
        generatedImageNodeCount: result.page.generatedImageNodeCount,
        outputDir: result.outputDir,
        images: result.images.map(({ domRecords: _domRecords, ...image }) => image),
        artifacts: result.artifacts,
        warnings: result.warnings,
      };
      return {
        structuredContent,
        content: [
          {
            type: "text" as const,
            text: `Extracted ${result.images.length} unique generated image(s) from ${result.page.href}.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "chatgpt_generate_images_async",
    {
      title: "Start async ChatGPT image generation",
      description:
        "Start a long-running ChatGPT image-generation job and return immediately with a job id. Poll oracle_job_status to collect generated image artifacts after completion.",
      inputSchema: generateImagesInputShape,
      outputSchema: asyncJobStartOutputShape,
    },
    async (input: unknown) => {
      const parsed = generateImagesInputSchema.parse(input);
      const daemonJob = await maybeStartDaemonJob("chatgpt_generate_images", parsed);
      if (daemonJob) {
        const structuredContent = { ...daemonJob };
        return {
          structuredContent,
          content: [
            {
              type: "text" as const,
              text: `Started daemon-backed ChatGPT image generation job ${daemonJob.jobId}. Poll oracle_job_status with this jobId.`,
            },
          ],
        };
      }
      const job = startMcpJob("chatgpt_generate_images", () => runGenerateImages(parsed));
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
            text: `Started ChatGPT image generation job ${job.id}. Poll oracle_job_status with this jobId.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "chatgpt_generate_images",
    {
      title: "Generate ChatGPT images",
      description:
        "Send a prompt through the logged-in browser, then collect generated image artifacts from the resulting conversation. Uses the current ChatGPT model/mode unless browserModelStrategy is changed.",
      inputSchema: generateImagesInputShape,
      outputSchema: generateImagesOutputShape,
    },
    async (input: unknown) => {
      const parsed = generateImagesInputSchema.parse(input);
      const structuredContent = await runGenerateImages(parsed);
      return {
        structuredContent,
        content: [
          {
            type: "text" as const,
            text: `Generated turn completed with ${structuredContent.uniqueGeneratedImageCount} image artifact(s).`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "chatgpt_edit_image_async",
    {
      title: "Start async ChatGPT image edit",
      description:
        "Start a long-running ChatGPT image-editing job with local reference attachments and return immediately with a job id. Poll oracle_job_status to collect artifacts after completion.",
      inputSchema: editImageInputShape,
      outputSchema: asyncJobStartOutputShape,
    },
    async (input: unknown) => {
      const parsed = editImageInputSchema.parse(input);
      const daemonJob = await maybeStartDaemonJob("chatgpt_edit_image", parsed);
      if (daemonJob) {
        const structuredContent = { ...daemonJob };
        return {
          structuredContent,
          content: [
            {
              type: "text" as const,
              text: `Started daemon-backed ChatGPT image edit job ${daemonJob.jobId}. Poll oracle_job_status with this jobId.`,
            },
          ],
        };
      }
      const job = startMcpJob("chatgpt_edit_image", () => runEditImage(parsed));
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
            text: `Started ChatGPT image edit job ${job.id}. Poll oracle_job_status with this jobId.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "chatgpt_edit_image",
    {
      title: "Edit ChatGPT image",
      description:
        "Send an image-editing prompt with local reference attachments through the logged-in browser, then collect generated image artifacts from the resulting conversation. Uses the current ChatGPT model/mode unless browserModelStrategy is changed.",
      inputSchema: editImageInputShape,
      outputSchema: editImageOutputShape,
    },
    async (input: unknown) => {
      const parsed = editImageInputSchema.parse(input);
      const structuredContent = await runEditImage(parsed);
      return {
        structuredContent,
        content: [
          {
            type: "text" as const,
            text: `Image edit turn completed with ${structuredContent.uniqueGeneratedImageCount} image artifact(s).`,
          },
        ],
      };
    },
  );
}

async function runGenerateImages(parsed: z.infer<typeof generateImagesInputSchema>) {
  const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
  const attachments = await resolveBrowserAttachments(parsed.files ?? []);
  const generation = await createChatgptSession({
    prompt: parsed.prompt,
    attachments,
    timeoutMs: parsed.timeoutMs ?? DEFAULT_CHATGPT_IMAGE_TURN_TIMEOUT_MS,
    includeSnapshot: true,
    config: {
      ...config,
      url: parsed.projectUrl ?? config.url,
      chatgptUrl: parsed.projectUrl ?? config.chatgptUrl,
      modelStrategy: parsed.browserModelStrategy as BrowserModelStrategy,
      desiredModel: parsed.browserModelLabel ?? config.desiredModel,
      thinkingTime: (parsed.browserThinkingTime ?? config.thinkingTime) as
        | ThinkingTimeLevel
        | undefined,
      thinkingFallback: parsed.thinkingFallback ?? config.thinkingFallback,
    },
  });
  const extractionWarnings: string[] = [];
  const extractionTimeoutMs =
    parsed.extractionTimeoutMs ??
    Math.min(parsed.timeoutMs ?? DEFAULT_CHATGPT_IMAGE_TURN_TIMEOUT_MS, 60_000);
  const extraction =
    generation.conversationUrl && parsed.artifactTypes.includes("images")
      ? await extractChatgptImagesFromConfiguredBrowser({
          conversationUrl: generation.conversationUrl,
          outputDir: parsed.outputDir,
          download: parsed.download,
          timeoutMs: extractionTimeoutMs,
          config,
        }).catch((error: unknown) => {
          extractionWarnings.push(
            `Post-generation image extraction failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        })
      : undefined;
  const sandboxExtraction =
    generation.conversationUrl && parsed.artifactTypes.includes("sandbox")
      ? await extractChatgptSandboxArtifactsFromConfiguredBrowser({
          conversationUrl: generation.conversationUrl,
          outputDir: parsed.outputDir,
          download: parsed.download,
          timeoutMs: extractionTimeoutMs,
          config,
        }).catch((error: unknown) => {
          extractionWarnings.push(
            `Post-generation sandbox artifact extraction failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        })
      : undefined;
  const detectedImageCount = Math.max(
    extraction?.images.length ?? 0,
    generation.newGeneratedImages?.length ?? 0,
    generation.generatedImages?.length ?? 0,
  );
  const warnings = [
    ...extractionWarnings,
    ...(extraction?.warnings ?? []),
    ...(detectedImageCount > 0
      ? []
      : [
          "No generated image artifacts were detected in the completed turn. Ensure the current ChatGPT mode is the image model before relying on this tool.",
        ]),
  ];
  return {
    conversationUrl: generation.conversationUrl,
    answerText: generation.answerText,
    answerMarkdown: generation.answerMarkdown,
    tookMs: generation.tookMs,
    newGeneratedImageCount: generation.newGeneratedImages?.length ?? 0,
    uniqueGeneratedImageCount: detectedImageCount,
    generatedImageNodeCount: extraction?.page.generatedImageNodeCount ?? 0,
    outputDir: extraction?.outputDir,
    images:
      extraction && extraction.images.length > 0
        ? extraction.images.map(({ domRecords: _domRecords, ...image }) => image)
        : (generation.generatedImages?.map(({ domRecords: _domRecords, ...image }) => image) ?? []),
    artifacts: extraction?.artifacts ?? [],
    sandboxArtifacts: sandboxExtraction?.sandboxArtifacts ?? generation.sandboxArtifacts ?? [],
    downloadedArtifacts:
      sandboxExtraction?.downloadedArtifacts ?? generation.downloadedSandboxArtifacts ?? [],
    thinkingTimeSelection: generation.thinkingTimeSelection,
    warnings,
  };
}

async function runEditImage(parsed: z.infer<typeof editImageInputSchema>) {
  const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
  const attachments = await resolveBrowserAttachments(parsed.files ?? []);
  const generation = await createChatgptSession({
    prompt: parsed.prompt,
    attachments,
    timeoutMs: parsed.timeoutMs ?? DEFAULT_CHATGPT_IMAGE_TURN_TIMEOUT_MS,
    includeSnapshot: true,
    config: {
      ...config,
      url: parsed.projectUrl ?? config.url,
      chatgptUrl: parsed.projectUrl ?? config.chatgptUrl,
      modelStrategy: parsed.browserModelStrategy as BrowserModelStrategy,
      desiredModel: parsed.browserModelLabel ?? config.desiredModel,
      thinkingTime: (parsed.browserThinkingTime ?? config.thinkingTime) as
        | ThinkingTimeLevel
        | undefined,
      thinkingFallback: parsed.thinkingFallback ?? config.thinkingFallback,
    },
  });
  const extractionWarnings: string[] = [];
  const extractionTimeoutMs =
    parsed.extractionTimeoutMs ??
    Math.min(parsed.timeoutMs ?? DEFAULT_CHATGPT_IMAGE_TURN_TIMEOUT_MS, 60_000);
  const extraction =
    generation.conversationUrl && parsed.artifactTypes.includes("images")
      ? await extractChatgptImagesFromConfiguredBrowser({
          conversationUrl: generation.conversationUrl,
          outputDir: parsed.outputDir,
          download: parsed.download,
          timeoutMs: extractionTimeoutMs,
          config,
        }).catch((error: unknown) => {
          extractionWarnings.push(
            `Post-generation image extraction failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        })
      : undefined;
  const sandboxExtraction =
    generation.conversationUrl && parsed.artifactTypes.includes("sandbox")
      ? await extractChatgptSandboxArtifactsFromConfiguredBrowser({
          conversationUrl: generation.conversationUrl,
          outputDir: parsed.outputDir,
          download: parsed.download,
          timeoutMs: extractionTimeoutMs,
          config,
        }).catch((error: unknown) => {
          extractionWarnings.push(
            `Post-generation sandbox artifact extraction failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        })
      : undefined;
  const detectedImageCount = Math.max(
    extraction?.images.length ?? 0,
    generation.newGeneratedImages?.length ?? 0,
    generation.generatedImages?.length ?? 0,
  );
  const warnings = [
    ...extractionWarnings,
    ...(extraction?.warnings ?? []),
    ...(detectedImageCount > 0
      ? []
      : [
          "No generated image artifacts were detected in the completed edit turn. Ensure the current ChatGPT mode is the image model before relying on this tool.",
        ]),
  ];
  return {
    conversationUrl: generation.conversationUrl,
    answerText: generation.answerText,
    answerMarkdown: generation.answerMarkdown,
    tookMs: generation.tookMs,
    newGeneratedImageCount: generation.newGeneratedImages?.length ?? 0,
    uniqueGeneratedImageCount: detectedImageCount,
    generatedImageNodeCount: extraction?.page.generatedImageNodeCount ?? 0,
    outputDir: extraction?.outputDir,
    images:
      extraction && extraction.images.length > 0
        ? extraction.images.map(({ domRecords: _domRecords, ...image }) => image)
        : (generation.generatedImages?.map(({ domRecords: _domRecords, ...image }) => image) ?? []),
    artifacts: extraction?.artifacts ?? [],
    sandboxArtifacts: sandboxExtraction?.sandboxArtifacts ?? generation.sandboxArtifacts ?? [],
    downloadedArtifacts:
      sandboxExtraction?.downloadedArtifacts ?? generation.downloadedSandboxArtifacts ?? [],
    thinkingTimeSelection: generation.thinkingTimeSelection,
    inputAttachments: attachments.map((attachment) => ({
      path: attachment.path,
      displayPath: attachment.displayPath,
      sizeBytes: attachment.sizeBytes,
    })),
    warnings,
  };
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

async function maybeStartDaemonJob(
  kind: "chatgpt_generate_images" | "chatgpt_edit_image",
  input: unknown,
) {
  const daemon = await resolveDaemonClientWithOptionalAutostart();
  if (!daemon) return null;
  return await daemon.startJob({ kind, input });
}
