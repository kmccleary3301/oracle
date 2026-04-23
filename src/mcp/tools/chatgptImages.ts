import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadUserConfig } from "../../config.js";
import { buildBrowserConfig } from "../../cli/browserConfig.js";
import { DEFAULT_MODEL } from "../../oracle.js";
import { extractChatgptImagesFromConfiguredBrowser } from "../../browser/chatgpt/imageArtifacts.js";
import { createChatgptSession } from "../../browser/chatgpt/session.js";
import { resolveBrowserAttachments } from "../../browser/attachmentResolver.js";
import type { BrowserModelStrategy } from "../../browser/types.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";

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
  browserModelStrategy: z.enum(["select", "current", "ignore"]).optional().default("current"),
  browserModelLabel: z.string().optional().describe("Exact/fuzzy ChatGPT model picker label to use."),
  browserThinkingTime: z
    .enum(["light", "standard", "extended", "heavy"])
    .optional()
    .describe("Thinking time intensity for image generation."),
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
  browserModelStrategy: z.enum(["select", "current", "ignore"]).optional().default("current"),
  browserModelLabel: z.string().optional().describe("Exact/fuzzy ChatGPT model picker label to use."),
  browserThinkingTime: z
    .enum(["light", "standard", "extended", "heavy"])
    .optional()
    .describe("Thinking time intensity for image editing."),
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
    "chatgpt_generate_images",
    {
      title: "Generate ChatGPT images",
      description:
        "Send a prompt through the logged-in browser, then collect generated image artifacts from the resulting conversation. Uses the current ChatGPT model/mode unless browserModelStrategy is changed.",
      inputSchema: generateImagesInputShape,
      outputSchema: generateImagesOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(generateImagesInputShape).parse(input);
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
        },
      });
      const extraction =
        generation.conversationUrl && generation.newGeneratedImages?.length
          ? await extractChatgptImagesFromConfiguredBrowser({
              conversationUrl: generation.conversationUrl,
              outputDir: parsed.outputDir,
              download: parsed.download,
              timeoutMs: Math.min(parsed.timeoutMs ?? DEFAULT_CHATGPT_IMAGE_TURN_TIMEOUT_MS, 60_000),
              config,
            })
          : undefined;
      const warnings =
        generation.newGeneratedImages?.length || generation.generatedImages?.length
          ? []
          : [
              "No generated image artifacts were detected in the completed turn. Ensure the current ChatGPT mode is the image model before relying on this tool.",
            ];
      const structuredContent = {
        conversationUrl: generation.conversationUrl,
        answerText: generation.answerText,
        answerMarkdown: generation.answerMarkdown,
        tookMs: generation.tookMs,
        newGeneratedImageCount: generation.newGeneratedImages?.length ?? 0,
        uniqueGeneratedImageCount: extraction?.images.length ?? generation.generatedImages?.length ?? 0,
        generatedImageNodeCount: extraction?.page.generatedImageNodeCount ?? 0,
        outputDir: extraction?.outputDir,
        images:
          extraction?.images.map(({ domRecords: _domRecords, ...image }) => image) ??
          generation.generatedImages?.map(({ domRecords: _domRecords, ...image }) => image) ??
          [],
        artifacts: extraction?.artifacts ?? [],
        warnings,
      };
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
    "chatgpt_edit_image",
    {
      title: "Edit ChatGPT image",
      description:
        "Send an image-editing prompt with local reference attachments through the logged-in browser, then collect generated image artifacts from the resulting conversation. Uses the current ChatGPT model/mode unless browserModelStrategy is changed.",
      inputSchema: editImageInputShape,
      outputSchema: editImageOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(editImageInputShape).parse(input);
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
        },
      });
      const extraction =
        generation.conversationUrl && generation.newGeneratedImages?.length
          ? await extractChatgptImagesFromConfiguredBrowser({
              conversationUrl: generation.conversationUrl,
              outputDir: parsed.outputDir,
              download: parsed.download,
              timeoutMs: Math.min(parsed.timeoutMs ?? DEFAULT_CHATGPT_IMAGE_TURN_TIMEOUT_MS, 60_000),
              config,
            })
          : undefined;
      const warnings =
        generation.newGeneratedImages?.length || generation.generatedImages?.length
          ? []
          : [
              "No generated image artifacts were detected in the completed edit turn. Ensure the current ChatGPT mode is the image model before relying on this tool.",
            ];
      const structuredContent = {
        conversationUrl: generation.conversationUrl,
        answerText: generation.answerText,
        answerMarkdown: generation.answerMarkdown,
        tookMs: generation.tookMs,
        newGeneratedImageCount: generation.newGeneratedImages?.length ?? 0,
        uniqueGeneratedImageCount: extraction?.images.length ?? generation.generatedImages?.length ?? 0,
        generatedImageNodeCount: extraction?.page.generatedImageNodeCount ?? 0,
        outputDir: extraction?.outputDir,
        images:
          extraction?.images.map(({ domRecords: _domRecords, ...image }) => image) ??
          generation.generatedImages?.map(({ domRecords: _domRecords, ...image }) => image) ??
          [],
        artifacts: extraction?.artifacts ?? [],
        inputAttachments: attachments.map((attachment) => ({
          path: attachment.path,
          displayPath: attachment.displayPath,
          sizeBytes: attachment.sizeBytes,
        })),
        warnings,
      };
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
