import { z } from "zod";
import { buildBrowserConfig } from "../cli/browserConfig.js";
import { loadUserConfig } from "../config.js";
import { resolveBrowserAttachments } from "../browser/attachmentResolver.js";
import { extractChatgptImagesFromConfiguredBrowser } from "../browser/chatgpt/imageArtifacts.js";
import { extractChatgptSandboxArtifactsFromConfiguredBrowser } from "../browser/chatgpt/sandboxArtifacts.js";
import { createChatgptSession, sendChatgptTurn } from "../browser/chatgpt/session.js";
import { listRemoteChromePageTargets } from "../browser/remoteChromeTabs.js";
import type { BrowserModelStrategy, BrowserRunOptions } from "../browser/types.js";
import { DEFAULT_MODEL } from "../oracle.js";
import type { ThinkingTimeLevel } from "../oracle/types.js";
import type { OracleDaemonJobHandler, OracleDaemonJobHandlerContext } from "./types.js";

const DEFAULT_CHATGPT_IMAGE_TURN_TIMEOUT_MS = 30 * 60_000;

const imageJobInputSchema = z.object({
  prompt: z.string().min(1),
  files: z.array(z.string()).optional().default([]),
  projectUrl: z.string().url().optional(),
  outputDir: z.string().optional(),
  download: z.boolean().optional().default(true),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().optional(),
  extractionTimeoutMs: z.number().optional(),
  browserModelStrategy: z.enum(["select", "current", "ignore"]).optional().default("current"),
  browserModelLabel: z.string().optional(),
  browserThinkingTime: z.enum(["light", "standard", "extended", "heavy"]).optional(),
  thinkingFallback: z.enum(["allow", "fail"]).optional().default("allow"),
  artifactTypes: z
    .array(z.enum(["images", "sandbox"]))
    .optional()
    .default(["images"]),
});

const createSessionJobInputSchema = z.object({
  prompt: z.string().min(1),
  files: z.array(z.string()).optional().default([]),
  sandboxArtifactsOutputDir: z.string().optional(),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().optional(),
  browserModelStrategy: z.enum(["select", "current", "ignore"]).optional().default("current"),
  browserModelLabel: z.string().optional(),
  includeSnapshot: z.boolean().optional().default(false),
});

const sendTurnJobInputSchema = createSessionJobInputSchema.extend({
  conversationUrl: z.string().url(),
});

const extractImagesJobInputSchema = z.object({
  conversationUrl: z.string().url(),
  outputDir: z.string().optional(),
  download: z.boolean().optional().default(true),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().optional(),
  keepTab: z.boolean().optional().default(false),
});

const extractSandboxArtifactsJobInputSchema = extractImagesJobInputSchema;

const recoverArtifactsInputSchema = z.object({
  jobId: z.string().optional(),
  conversationUrl: z.string().url().optional(),
  outputDir: z.string().optional(),
  download: z.boolean().optional().default(true),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().optional(),
  keepTab: z.boolean().optional().default(false),
  artifactTypes: z
    .array(z.enum(["images", "sandbox"]))
    .optional()
    .default(["images", "sandbox"]),
  jobRuntime: z
    .object({
      remoteChrome: z.string().optional(),
      conversationUrl: z.string().optional(),
      tabId: z.string().optional(),
    })
    .optional(),
});

export function createChatgptDaemonHandlers(): OracleDaemonJobHandler[] {
  return [
    {
      kind: "chatgpt_generate_images",
      async run(context, input) {
        return await runImageJob(context, input, false);
      },
    },
    {
      kind: "chatgpt_edit_image",
      async run(context, input) {
        return await runImageJob(context, input, true);
      },
    },
    {
      kind: "chatgpt_create_session",
      async run(context, input) {
        return await runCreateSessionJob(context, input);
      },
    },
    {
      kind: "chatgpt_send_turn",
      async run(context, input) {
        return await runSendTurnJob(context, input);
      },
    },
    {
      kind: "chatgpt_extract_images",
      async run(context, input) {
        const parsed = extractImagesJobInputSchema.parse(input);
        const config = await resolveDaemonBrowserConfig(parsed.remoteChrome);
        await context.setPhase("extracting_images", "Extracting generated image artifacts.");
        const result = await extractChatgptImagesFromConfiguredBrowser({
          conversationUrl: parsed.conversationUrl,
          outputDir: parsed.outputDir,
          download: parsed.download,
          timeoutMs: parsed.timeoutMs,
          keepTab: parsed.keepTab,
          config,
        });
        return {
          conversationUrl: result.page.href,
          uniqueGeneratedImageCount: result.images.length,
          generatedImageNodeCount: result.page.generatedImageNodeCount,
          outputDir: result.outputDir,
          images: result.images.map(({ domRecords: _domRecords, ...image }) => image),
          artifacts: result.artifacts,
          warnings: result.warnings,
        };
      },
    },
    {
      kind: "chatgpt_extract_sandbox_artifacts",
      async run(context, input) {
        const parsed = extractSandboxArtifactsJobInputSchema.parse(input);
        const config = await resolveDaemonBrowserConfig(parsed.remoteChrome);
        await context.setPhase("extracting_sandbox_artifacts", "Extracting sandbox artifacts.");
        const result = await extractChatgptSandboxArtifactsFromConfiguredBrowser({
          conversationUrl: parsed.conversationUrl,
          outputDir: parsed.outputDir,
          download: parsed.download,
          timeoutMs: parsed.timeoutMs,
          keepTab: parsed.keepTab,
          config,
        });
        return {
          conversationUrl: result.page.href,
          outputDir: result.outputDir,
          sandboxArtifacts: result.sandboxArtifacts,
          downloadedArtifacts: result.downloadedArtifacts,
          warnings: result.warnings,
        };
      },
    },
  ];
}

export async function recoverChatgptJobArtifacts(input: unknown) {
  const parsed = recoverArtifactsInputSchema.parse(input);
  const config = await resolveDaemonBrowserConfig(
    parsed.remoteChrome ?? parsed.jobRuntime?.remoteChrome,
  );
  const remoteChrome = config.remoteChrome;
  const conversationUrl =
    parsed.conversationUrl ??
    parsed.jobRuntime?.conversationUrl ??
    (remoteChrome
      ? await discoverLatestChatgptConversationUrl(remoteChrome.host, remoteChrome.port)
      : undefined);
  if (!conversationUrl) {
    throw new Error(
      "Unable to recover job artifacts: no conversationUrl was provided, recorded on the job, or discoverable from active ChatGPT tabs.",
    );
  }

  const warnings: string[] = [];
  let imageExtraction:
    | Awaited<ReturnType<typeof extractChatgptImagesFromConfiguredBrowser>>
    | undefined;
  let sandboxExtraction:
    | Awaited<ReturnType<typeof extractChatgptSandboxArtifactsFromConfiguredBrowser>>
    | undefined;

  if (parsed.artifactTypes.includes("images")) {
    imageExtraction = await extractChatgptImagesFromConfiguredBrowser({
      conversationUrl,
      outputDir: parsed.outputDir,
      download: parsed.download,
      timeoutMs: parsed.timeoutMs,
      keepTab: parsed.keepTab,
      config,
    }).catch((error: unknown) => {
      warnings.push(
        `Image recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    });
  }

  if (parsed.artifactTypes.includes("sandbox")) {
    sandboxExtraction = await extractChatgptSandboxArtifactsFromConfiguredBrowser({
      conversationUrl,
      outputDir: parsed.outputDir,
      download: parsed.download,
      timeoutMs: parsed.timeoutMs,
      keepTab: parsed.keepTab,
      config,
    }).catch((error: unknown) => {
      warnings.push(
        `Sandbox artifact recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    });
  }

  return normalizeRecoveredArtifactsResult({
    conversationUrl,
    imageExtraction,
    sandboxExtraction,
    warnings,
    recoveredFrom: parsed.conversationUrl
      ? "input-conversation-url"
      : parsed.jobRuntime?.conversationUrl
        ? "job-runtime"
        : "active-tab",
  });
}

async function runCreateSessionJob(context: OracleDaemonJobHandlerContext, input: unknown) {
  const parsed = createSessionJobInputSchema.parse(input);
  await context.setPhase("uploading_attachments", "Resolving browser attachments.");
  const config = await resolveDaemonBrowserConfig(parsed.remoteChrome);
  const attachments = await resolveBrowserAttachments(parsed.files);
  await context.setPhase("submitting_prompt", "Submitting ChatGPT session prompt.");
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
    runtimeHintCb: createRuntimeHintCallback(context),
    log: (message) => {
      void context.log(message);
    },
  });
  return serializeTurnResult(result);
}

async function runSendTurnJob(context: OracleDaemonJobHandlerContext, input: unknown) {
  const parsed = sendTurnJobInputSchema.parse(input);
  await context.setPhase("uploading_attachments", "Resolving browser attachments.");
  const config = await resolveDaemonBrowserConfig(parsed.remoteChrome);
  const attachments = await resolveBrowserAttachments(parsed.files);
  await context.setPhase("submitting_prompt", "Submitting ChatGPT conversation turn.");
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
    runtimeHintCb: createRuntimeHintCallback(context),
    log: (message) => {
      void context.log(message);
    },
  });
  return serializeTurnResult(result);
}

async function runImageJob(
  context: OracleDaemonJobHandlerContext,
  input: unknown,
  requireAttachments: boolean,
) {
  const parsed = imageJobInputSchema.parse(input);
  if (requireAttachments && parsed.files.length === 0) {
    throw new Error("Image edit requires at least one file attachment.");
  }
  await context.setPhase("uploading_attachments", "Resolving browser attachments.");
  const config = await resolveDaemonBrowserConfig(parsed.remoteChrome);
  const attachments = await resolveBrowserAttachments(parsed.files);
  await context.setPhase("submitting_prompt", "Submitting ChatGPT image turn.");
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
    runtimeHintCb: createRuntimeHintCallback(context),
    log: (message) => {
      void context.log(message);
    },
  });
  await context.updateRuntime({
    conversationUrl: generation.conversationUrl,
    remoteChrome:
      generation.chromeHost && generation.chromePort
        ? `${generation.chromeHost}:${generation.chromePort}`
        : undefined,
    tabId: generation.chromeTargetId,
  });
  await context.setPhase("extracting_images", "Extracting generated image artifacts.");
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
  let sandboxExtraction:
    | Awaited<ReturnType<typeof extractChatgptSandboxArtifactsFromConfiguredBrowser>>
    | undefined;
  if (generation.conversationUrl && parsed.artifactTypes.includes("sandbox")) {
    await context.setPhase("extracting_sandbox_artifacts", "Extracting sandbox artifacts.");
    sandboxExtraction = await extractChatgptSandboxArtifactsFromConfiguredBrowser({
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
    });
  }
  const detectedImageCount = Math.max(
    extraction?.images.length ?? 0,
    generation.newGeneratedImages?.length ?? 0,
    generation.generatedImages?.length ?? 0,
  );
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
    warnings: [
      ...extractionWarnings,
      ...(extraction?.warnings ?? []),
      ...(sandboxExtraction?.warnings ?? []),
      ...(detectedImageCount > 0
        ? []
        : [
            "No generated image artifacts were detected in the completed turn. Ensure the current ChatGPT mode is the image model before relying on this job.",
          ]),
    ],
  };
}

function createRuntimeHintCallback(
  context: OracleDaemonJobHandlerContext,
): NonNullable<BrowserRunOptions["runtimeHintCb"]> {
  return async (hint) => {
    await context.updateRuntime({
      browserProfileDir: hint.userDataDir,
      remoteChrome:
        hint.chromeHost && hint.chromePort ? `${hint.chromeHost}:${hint.chromePort}` : undefined,
      tabId: hint.chromeTargetId,
      conversationUrl: hint.tabUrl,
      conversationId: hint.conversationId,
    });
  };
}

async function resolveDaemonBrowserConfig(remoteChrome?: string) {
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

async function discoverLatestChatgptConversationUrl(
  host: string,
  port: number,
): Promise<string | undefined> {
  const targets = await listRemoteChromePageTargets(host, port, { chatgptOnly: true });
  const conversations = targets
    .map((target) => target.url)
    .filter((url): url is string => Boolean(url && /\/c\/[a-z0-9-]+/i.test(url)));
  return conversations.at(-1);
}

function normalizeRecoveredArtifactsResult(input: {
  conversationUrl: string;
  imageExtraction?: Awaited<ReturnType<typeof extractChatgptImagesFromConfiguredBrowser>>;
  sandboxExtraction?: Awaited<
    ReturnType<typeof extractChatgptSandboxArtifactsFromConfiguredBrowser>
  >;
  warnings: string[];
  recoveredFrom: string;
}) {
  const imageWarnings = input.imageExtraction?.warnings ?? [];
  const sandboxWarnings = input.sandboxExtraction?.warnings ?? [];
  return {
    recovered: Boolean(input.imageExtraction || input.sandboxExtraction),
    recoveredFrom: input.recoveredFrom,
    conversationUrl: input.conversationUrl,
    outputDir: input.imageExtraction?.outputDir ?? input.sandboxExtraction?.outputDir,
    images:
      input.imageExtraction?.images.map(({ domRecords: _domRecords, ...image }) => image) ?? [],
    imageArtifacts: input.imageExtraction?.artifacts ?? [],
    sandboxArtifacts: input.sandboxExtraction?.sandboxArtifacts ?? [],
    downloadedArtifacts: input.sandboxExtraction?.downloadedArtifacts ?? [],
    warnings: [...input.warnings, ...imageWarnings, ...sandboxWarnings],
  };
}
