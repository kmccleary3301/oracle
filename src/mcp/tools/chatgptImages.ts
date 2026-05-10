import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveTrustedBrowserConfig } from "../../browser/trustedBrowserConfig.js";
import {
  editChatgptImage,
  extractChatgptImageArtifacts,
  generateChatgptImage,
  listChatgptImageLibraryFromConfiguredBrowser,
  verifyChatgptImageModeFromConfiguredBrowser,
} from "../../browser/chatgpt/imageService.js";
import { extractChatgptSandboxArtifactsFromConfiguredBrowser } from "../../browser/chatgpt/sandboxArtifacts.js";
import { resolveBrowserAttachments } from "../../browser/attachmentResolver.js";
import type { ChatgptTurnResult } from "../../browser/chatgpt/types.js";
import type { BrowserModelStrategy } from "../../browser/types.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";
import { startMcpJob } from "../jobs.js";

const DEFAULT_CHATGPT_IMAGE_TURN_TIMEOUT_MS = 30 * 60_000;
const thinkingFallbackSchema = z
  .enum([
    "allow",
    "fail",
    "submit-current-with-warning",
    "skip-if-control-absent",
    "wait-for-manual",
  ])
  .optional()
  .default("allow")
  .describe("Thinking selector fallback policy.");

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

const imageLibraryInputShape = {
  remoteChrome: z.string().optional(),
  libraryUrl: z.string().url().optional(),
  timeoutMs: z.number().optional(),
  keepTab: z.boolean().optional().default(false),
} satisfies z.ZodRawShape;

const imageLibraryGetInputShape = {
  ...imageLibraryInputShape,
  fileId: z.string().min(1),
  turnId: z.string().optional(),
  messageId: z.string().optional(),
} satisfies z.ZodRawShape;
const imageGetInputShape = {
  ...extractImagesInputShape,
  fileId: z.string().min(1),
  turnId: z.string().optional(),
  messageId: z.string().optional(),
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
  thinkingFallback: thinkingFallbackSchema,
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
  thinkingFallback: thinkingFallbackSchema,
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

const imageLibraryOutputShape = {
  state: z.enum(["completed", "partial"]),
  entries: z.array(
    z.object({
      fileId: z.string(),
      sourceUrl: z.string(),
      turnId: z.string().nullable().optional(),
      messageId: z.string().nullable().optional(),
      turnIndex: z.number().nullable().optional(),
      variantIndex: z.number(),
      outputIndex: z.number(),
      renderedWidth: z.number(),
      renderedHeight: z.number(),
      isThumbnail: z.boolean(),
      duplicateNodeCount: z.number(),
      mimeType: z.string().optional(),
      byteSize: z.number().optional(),
      sha256: z.string().optional(),
      createdAt: z.string().optional(),
    }),
  ),
  warnings: z.array(z.string()),
} satisfies z.ZodRawShape;

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
      const browserConfig = await resolveTrustedBrowserConfig(parsed.remoteChrome);
      const result = await extractChatgptImageArtifacts({
        conversationUrl: parsed.conversationUrl,
        outputDir: parsed.outputDir,
        download: parsed.download,
        timeoutMs: parsed.timeoutMs,
        keepTab: parsed.keepTab,
        config: browserConfig,
      });
      const structuredContent = {
        conversationUrl: result.page.href,
        uniqueGeneratedImageCount: result.images.length,
        generatedImageNodeCount: result.page.generatedImageNodeCount,
        outputDir: result.outputDir,
        images: result.images,
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
      const daemonJob = await startMcpJob("chatgpt_generate_images", parsed);
      const structuredContent = { ...daemonJob };
      return {
        structuredContent,
        content: [
          {
            type: "text" as const,
            text: `Started durable ChatGPT image generation job ${daemonJob.jobId}. Poll oracle_job_status with this jobId.`,
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
      const daemonJob = await startMcpJob("chatgpt_edit_image", parsed);
      const structuredContent = { ...daemonJob };
      return {
        structuredContent,
        content: [
          {
            type: "text" as const,
            text: `Started durable ChatGPT image edit job ${daemonJob.jobId}. Poll oracle_job_status with this jobId.`,
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
  for (const registration of [
    { name: "chatgpt_image_library_list", get: false },
    { name: "chatgpt_image_library_get", get: true },
  ] as const) {
    server.registerTool(
      registration.name,
      {
        title: registration.get ? "Get ChatGPT image library entry" : "List ChatGPT image library",
        description: "Read public ChatGPT image library metadata without private DOM labels.",
        inputSchema: registration.get ? imageLibraryGetInputShape : imageLibraryInputShape,
        outputSchema: imageLibraryOutputShape,
      },
      async (input: unknown) => {
        if (registration.get) {
          const parsed = z.object(imageLibraryGetInputShape).parse(input);
          const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
          const result = await listChatgptImageLibraryFromConfiguredBrowser({
            config,
            libraryUrl: parsed.libraryUrl,
            timeoutMs: parsed.timeoutMs,
            keepTab: parsed.keepTab,
          });
          const entries = result.entries.filter(
            (entry) =>
              entry.fileId === parsed.fileId &&
              (parsed.turnId === undefined || entry.turnId === parsed.turnId) &&
              (parsed.messageId === undefined || entry.messageId === parsed.messageId),
          );
          return {
            structuredContent: { ...result, entries },
            content: [
              {
                type: "text" as const,
                text: `Found ${entries.length} image library entr${entries.length === 1 ? "y" : "ies"}.`,
              },
            ],
          };
        }
        const parsed = z.object(imageLibraryInputShape).parse(input);
        const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
        const result = await listChatgptImageLibraryFromConfiguredBrowser({
          config,
          libraryUrl: parsed.libraryUrl,
          timeoutMs: parsed.timeoutMs,
          keepTab: parsed.keepTab,
        });
        const entries = result.entries;
        return {
          structuredContent: { ...result, entries },
          content: [
            {
              type: "text" as const,
              text: `Found ${entries.length} image library entr${entries.length === 1 ? "y" : "ies"}.`,
            },
          ],
        };
      },
    );
  }

  server.registerTool(
    "chatgpt_get_image",
    {
      title: "Get ChatGPT image metadata",
      description: "Get one exact generated image by file, turn, and message identity.",
      inputSchema: imageGetInputShape,
      outputSchema: extractImagesOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(imageGetInputShape).parse(input);
      const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
      const result = await extractChatgptImageArtifacts({ ...parsed, config, download: false });
      const images = result.images.filter(
        (image) =>
          image.fileId === parsed.fileId &&
          (parsed.turnId === undefined || image.turnId === parsed.turnId) &&
          (parsed.messageId === undefined || image.messageId === parsed.messageId),
      );
      return {
        structuredContent: {
          conversationUrl: result.page.href,
          uniqueGeneratedImageCount: images.length,
          generatedImageNodeCount: result.page.generatedImageNodeCount,
          outputDir: result.outputDir,
          images,
          artifacts: [],
          warnings: result.warnings,
        },
        content: [{ type: "text" as const, text: `Found ${images.length} exact image target(s).` }],
      };
    },
  );

  server.registerTool(
    "chatgpt_download_image",
    {
      title: "Download ChatGPT image",
      description: "Download one exact generated image at full quality with byte metadata.",
      inputSchema: imageGetInputShape,
      outputSchema: extractImagesOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(imageGetInputShape).parse(input);
      const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
      const result = await extractChatgptImageArtifacts({ ...parsed, config, download: true });
      const images = result.images.filter(
        (image) =>
          image.fileId === parsed.fileId &&
          (parsed.turnId === undefined || image.turnId === parsed.turnId) &&
          (parsed.messageId === undefined || image.messageId === parsed.messageId),
      );
      return {
        structuredContent: {
          conversationUrl: result.page.href,
          uniqueGeneratedImageCount: images.length,
          generatedImageNodeCount: result.page.generatedImageNodeCount,
          outputDir: result.outputDir,
          images,
          artifacts: result.artifacts.filter((artifact) =>
            images.some((image) => image.fileId === artifact.fileId),
          ),
          warnings: result.warnings,
        },
        content: [
          { type: "text" as const, text: `Downloaded ${images.length} exact image target(s).` },
        ],
      };
    },
  );
}

async function runGenerateImages(parsed: z.infer<typeof generateImagesInputSchema>) {
  const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
  const attachments = await resolveBrowserAttachments(parsed.files ?? []);
  const sessionConfig = {
    ...config,
    url: parsed.projectUrl ?? config.url,
    chatgptUrl: parsed.projectUrl ?? config.chatgptUrl,
    modelStrategy: parsed.browserModelStrategy as BrowserModelStrategy,
    desiredModel: parsed.browserModelLabel ?? config.desiredModel,
    thinkingTime: (parsed.browserThinkingTime ?? config.thinkingTime) as
      | ThinkingTimeLevel
      | undefined,
    thinkingFallback: parsed.thinkingFallback ?? config.thinkingFallback,
  };
  const operation = await generateChatgptImage({
    prompt: parsed.prompt,
    attachments,
    timeoutMs: parsed.timeoutMs ?? DEFAULT_CHATGPT_IMAGE_TURN_TIMEOUT_MS,
    includeSnapshot: true,
    config: sessionConfig,
    requireVerifiedMode: true,
    verifyMode: () =>
      verifyChatgptImageModeFromConfiguredBrowser({
        config: sessionConfig,
        timeoutMs: parsed.timeoutMs,
      }),
  });
  if (
    operation.state !== "completed" ||
    !operation.value ||
    typeof operation.value !== "object" ||
    !("turn" in operation.value)
  ) {
    throw new Error(
      `${operation.failure?.code ?? operation.state}: ${operation.failure?.message ?? "ChatGPT image generation did not complete."}`,
    );
  }
  const operationValue = operation.value as { turn: ChatgptTurnResult };
  const generation = operationValue.turn;
  const extractionWarnings: string[] = [];
  const extractionTimeoutMs =
    parsed.extractionTimeoutMs ??
    Math.min(parsed.timeoutMs ?? DEFAULT_CHATGPT_IMAGE_TURN_TIMEOUT_MS, 60_000);
  const extraction =
    generation.conversationUrl && parsed.artifactTypes.includes("images")
      ? await extractChatgptImageArtifacts({
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
        ? extraction.images
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
  const sessionConfig = {
    ...config,
    url: parsed.projectUrl ?? config.url,
    chatgptUrl: parsed.projectUrl ?? config.chatgptUrl,
    modelStrategy: parsed.browserModelStrategy as BrowserModelStrategy,
    desiredModel: parsed.browserModelLabel ?? config.desiredModel,
    thinkingTime: (parsed.browserThinkingTime ?? config.thinkingTime) as
      | ThinkingTimeLevel
      | undefined,
    thinkingFallback: parsed.thinkingFallback ?? config.thinkingFallback,
  };
  const operation = await editChatgptImage({
    prompt: parsed.prompt,
    attachments,
    timeoutMs: parsed.timeoutMs ?? DEFAULT_CHATGPT_IMAGE_TURN_TIMEOUT_MS,
    includeSnapshot: true,
    config: sessionConfig,
    requireVerifiedMode: true,
    verifyMode: () =>
      verifyChatgptImageModeFromConfiguredBrowser({
        config: sessionConfig,
        timeoutMs: parsed.timeoutMs,
      }),
  });
  if (
    operation.state !== "completed" ||
    !operation.value ||
    typeof operation.value !== "object" ||
    !("turn" in operation.value)
  ) {
    throw new Error(
      `${operation.failure?.code ?? operation.state}: ${operation.failure?.message ?? "ChatGPT image edit did not complete."}`,
    );
  }
  const operationValue = operation.value as { turn: ChatgptTurnResult };
  const generation = operationValue.turn;
  const extractionWarnings: string[] = [];
  const extractionTimeoutMs =
    parsed.extractionTimeoutMs ??
    Math.min(parsed.timeoutMs ?? DEFAULT_CHATGPT_IMAGE_TURN_TIMEOUT_MS, 60_000);
  const extraction =
    generation.conversationUrl && parsed.artifactTypes.includes("images")
      ? await extractChatgptImageArtifacts({
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
        ? extraction.images
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

const resolveMcpBrowserConfig = resolveTrustedBrowserConfig;
