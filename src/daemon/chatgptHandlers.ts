import { z } from "zod";
import { resolveTrustedBrowserConfig } from "../browser/trustedBrowserConfig.js";
import { resolveBrowserAttachments } from "../browser/attachmentResolver.js";
import { closeRemoteChromeTarget, connectToRemoteChrome } from "../browser/chromeLifecycle.js";
import { extractChatgptImagesFromConfiguredBrowser } from "../browser/chatgpt/imageArtifacts.js";
import { extractChatgptSandboxArtifactsFromConfiguredBrowser } from "../browser/chatgpt/sandboxArtifacts.js";
import {
  editChatgptImage,
  generateChatgptImage,
  verifyChatgptImageModeFromConfiguredBrowser,
} from "../browser/chatgpt/imageService.js";
import {
  createRuntimeWorkService,
  type WorkApprovalResult,
  type WorkSnapshot,
} from "../browser/chatgpt/work.js";
import { createChatgptSession, sendChatgptTurn } from "../browser/chatgpt/session.js";
import type { ApprovalGrantAuthority } from "../browser/approvalToken.js";
import { listRemoteChromePageTargets } from "../browser/remoteChromeTabs.js";
import { navigateToChatGPT } from "../browser/actions/navigation.js";
import type { BrowserModelStrategy, BrowserRunOptions } from "../browser/types.js";
import type { ThinkingTimeLevel } from "../oracle/types.js";
import type {
  OracleDaemonJobHandler,
  OracleDaemonJobHandlerContext,
  OracleDaemonWorkInput,
  OracleDaemonWorkOperation,
  OracleDaemonWorkResult,
} from "./types.js";

const DEFAULT_CHATGPT_IMAGE_TURN_TIMEOUT_MS = 30 * 60_000;
export interface ChatgptDaemonHandlerOptions {
  approvalAuthority?: ApprovalGrantAuthority;
  principal?: string;
  session?: string;
}

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
  projectUrl: z.string().url().optional(),
  sandboxArtifactsOutputDir: z.string().optional(),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().optional(),
  browserModelStrategy: z.enum(["select", "current", "ignore"]).optional().default("current"),
  browserModelLabel: z.string().optional(),
  browserThinkingTime: z.enum(["light", "standard", "extended", "heavy"]).optional(),
  thinkingFallback: z.enum(["allow", "fail"]).optional().default("allow"),
  includeSnapshot: z.boolean().optional().default(false),
  returnAfterSubmit: z.boolean().optional().default(false),
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

const workStartInputSchema = z.object({
  prompt: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  task: z.string().optional(),
  deliverable: z.string().optional(),
  deliverables: z.record(z.string(), z.unknown()).optional(),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
  keepTab: z.boolean().optional().default(false),
});

const workStatusInputSchema = z.object({
  conversationId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
  keepTab: z.boolean().optional().default(false),
});

const workAnswerInputSchema = workStatusInputSchema.extend({
  taskId: z.string().min(1),
  questionId: z.string().min(1),
  answer: z.string().min(1),
  turnId: z.string().min(1).optional(),
  expectedRevisionHash: z.string().min(1).optional(),
});

const workApproveInputSchema = workStatusInputSchema.extend({
  taskId: z.string().min(1),
  expectedRevisionHash: z.string().min(1),
  approvalGrant: z.string().optional(),
  dryRun: z.boolean().optional().default(false),
});

const workInterruptInputSchema = workStatusInputSchema.extend({
  taskId: z.string().min(1),
  turnId: z.string().min(1),
});
export function createChatgptDaemonHandlers(
  options: ChatgptDaemonHandlerOptions = {},
): OracleDaemonJobHandler[] {
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
      kind: "chatgpt_work_start",
      async run(context, input) {
        return await runChatgptWorkOperation("start", input, context, options);
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
export async function runChatgptWorkOperation(
  operation: OracleDaemonWorkOperation,
  input: unknown,
  context?: OracleDaemonJobHandlerContext,
  options: ChatgptDaemonHandlerOptions = {},
): Promise<OracleDaemonWorkResult> {
  const parsed = (
    operation === "start"
      ? workStartInputSchema.parse(input)
      : operation === "answer"
        ? workAnswerInputSchema.parse(input)
        : operation === "approve"
          ? workApproveInputSchema.parse(input)
          : operation === "interrupt"
            ? workInterruptInputSchema.parse(input)
            : workStatusInputSchema.parse(input)
  ) as OracleDaemonWorkInput;
  const metadata = {
    taskId: parsed.taskId,
    task: parsed.task,
    deliverable: parsed.deliverable,
    deliverables: parsed.deliverables,
  };
  const config = await resolveDaemonBrowserConfig(parsed.remoteChrome);
  if (!config.remoteChrome) {
    return {
      operation,
      state: "unsupported",
      accepted: false,
      conversationId: parsed.conversationId ?? null,
      conversationUrl: null,
      questionId: parsed.questionId ?? null,
      revisionHash: parsed.expectedRevisionHash ?? null,
      reason: "remote-chrome-unavailable",
      ...metadata,
    };
  }
  const targetUrl = parsed.conversationId
    ? `${config.chatgptUrl ?? config.url ?? "https://chatgpt.com"}/c/${parsed.conversationId}`
    : (config.chatgptUrl ?? config.url ?? "https://chatgpt.com");
  const logger = (message: string) => {
    if (context) void context.log(message);
  };
  const connection = await connectToRemoteChrome(
    config.remoteChrome.host,
    config.remoteChrome.port,
    logger,
    targetUrl,
    undefined,
    { maxTabs: config.remoteChromeMaxTabs },
  );
  try {
    const { Page, Runtime, Input } = connection.client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    await navigateToChatGPT(Page, Runtime, targetUrl, logger);
    const service = createRuntimeWorkService({
      Runtime,
      Input,
      timeoutMs: parsed.timeoutMs ?? config.inputTimeoutMs ?? 60_000,
      logger,
      approvalAuthority: options.approvalAuthority,
      principal: options.principal,
      session: options.session,
    });
    if (context) {
      await context.updateRuntime({
        remoteChrome: `${config.remoteChrome.host}:${config.remoteChrome.port}`,
        tabId: connection.targetId,
      });
    }
    let result: OracleDaemonWorkResult;
    if (operation === "start") {
      if (context) await context.setPhase("submitting_prompt", "Submitting ChatGPT Work prompt.");
      const started = await service.start({
        prompt: parsed.prompt!,
        conversationId: parsed.conversationId,
        taskId: parsed.taskId,
      });
      result = {
        operation,
        state: started.state,
        accepted: started.accepted,
        conversationId: started.conversationId,
        conversationUrl: started.conversationUrl,
        ...metadata,
        taskId: started.taskId ?? metadata.taskId,
        turnId: started.turnId,
        revisionHash: started.revisionHash,
        deliverables: started.deliverables ?? metadata.deliverables,
        provenance: started.provenance,
      };
    } else if (operation === "status") {
      const snapshot = await service.status({
        conversationId: parsed.conversationId!,
        taskId: parsed.taskId,
      });
      result = workSnapshotResult(operation, snapshot, metadata);
    } else if (operation === "answer") {
      const answered = await service.answer({
        conversationId: parsed.conversationId!,
        taskId: parsed.taskId,
        questionId: parsed.questionId,
        answer: parsed.answer!,
        turnId: parsed.turnId,
        expectedRevisionHash: parsed.expectedRevisionHash,
      });
      result = {
        operation,
        state: answered.state,
        accepted: answered.accepted,
        reason: answered.reason,
        conversationId: answered.conversationId,
        questionId: parsed.questionId,
        ...metadata,
        taskId: answered.taskId ?? metadata.taskId,
        turnId: answered.turnId,
        revisionHash: answered.revisionHash,
        deliverables: answered.deliverables ?? metadata.deliverables,
        provenance: answered.provenance,
      };
    } else if (operation === "approve") {
      const approved: WorkApprovalResult = await service.approve({
        conversationId: parsed.conversationId!,
        taskId: parsed.taskId,
        expectedRevisionHash: parsed.expectedRevisionHash,
        approvalGrant: parsed.approvalGrant,
        dryRun: parsed.dryRun,
      });
      result = {
        operation,
        state: approved.state,
        dryRun: approved.dryRun,
        approvalChallenge: approved.approvalChallenge,
        reason: approved.reason,
        conversationId: approved.conversationId ?? parsed.conversationId!,
        ...metadata,
        taskId: approved.taskId ?? metadata.taskId,
        revisionHash: approved.revisionHash ?? approved.plan?.revisionHash,
        turnId: approved.turnId,
        deliverables: approved.deliverables ?? metadata.deliverables,
        provenance: approved.provenance,
      };
    } else {
      const interrupted = await service.interrupt({
        conversationId: parsed.conversationId!,
        taskId: parsed.taskId,
        turnId: parsed.turnId,
      });
      result = {
        operation,
        state: interrupted.state,
        verified: interrupted.verified,
        reason: interrupted.reason,
        conversationId: interrupted.conversationId ?? parsed.conversationId!,
        ...metadata,
        taskId: interrupted.taskId ?? metadata.taskId,
        turnId: interrupted.turnId ?? parsed.turnId,
        revisionHash: interrupted.revisionHash,
        deliverables: interrupted.deliverables ?? metadata.deliverables,
        provenance: interrupted.provenance,
      };
    }
    if (context) {
      await context.updateRuntime({
        conversationId: result.conversationId ?? undefined,
        conversationUrl: result.conversationUrl ?? undefined,
        work: {
          state: result.state,
          conversationId: result.conversationId ?? undefined,
          taskId: result.taskId,
          turnId: result.turnId ?? undefined,
          revisionHash: result.revisionHash ?? undefined,
          deliverables: result.deliverables,
          provenance: result.provenance,
        },
      });
    }
    return result;
  } finally {
    try {
      await connection.client.close();
    } finally {
      if (!parsed.keepTab) {
        await closeRemoteChromeTarget(
          config.remoteChrome.host,
          config.remoteChrome.port,
          connection.targetId,
          logger,
        );
      }
    }
  }
}

function workSnapshotResult(
  operation: OracleDaemonWorkOperation,
  snapshot: WorkSnapshot,
  metadata: OracleDaemonWorkInput,
): OracleDaemonWorkResult {
  return {
    operation,
    state: snapshot.state,
    reason: snapshot.reason,
    conversationId: snapshot.conversationId,
    conversationUrl: snapshot.url || null,
    taskId: snapshot.taskId ?? metadata.taskId,
    questionId: snapshot.userQuestion?.id ?? null,
    turnId: snapshot.turn?.id,
    revisionHash:
      snapshot.revisionHash ?? snapshot.turn?.revisionHash ?? snapshot.plan?.revisionHash,
    plan: snapshot.plan ? { ...snapshot.plan } : undefined,
    userQuestion: snapshot.userQuestion ? { ...snapshot.userQuestion } : undefined,
    task: metadata.task,
    deliverable: metadata.deliverable,
    deliverables: snapshot.deliverables ?? metadata.deliverables,
    provenance: snapshot.provenance,
  };
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
    includeSnapshot: parsed.returnAfterSubmit ? false : parsed.includeSnapshot,
    returnAfterSubmit: parsed.returnAfterSubmit,
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
      sandboxArtifactsOutputDir:
        parsed.sandboxArtifactsOutputDir ?? config.sandboxArtifactsOutputDir,
    },
    runtimeHintCb: createRuntimeHintCallback(context),
    beforeSend: () => context.markSubmission("submitting", { reasonCode: "submission_started" }),
    onPromptSubmitted: () =>
      context.markSubmission("accepted", { reasonCode: "submission_accepted" }),
    log: (message) => {
      void context.log(message);
    },
  });
  if (result.status === "submitted") {
    await context.markSubmission("accepted", { reasonCode: "submission_accepted" });
  } else if (result.submitted) {
    await context.markSubmission("submitted", { reasonCode: "submission_committed" });
  }
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
    includeSnapshot: parsed.returnAfterSubmit ? false : parsed.includeSnapshot,
    returnAfterSubmit: parsed.returnAfterSubmit,
    config: {
      ...config,
      modelStrategy: parsed.browserModelStrategy as BrowserModelStrategy,
      desiredModel: parsed.browserModelLabel ?? config.desiredModel,
      thinkingTime: (parsed.browserThinkingTime ?? config.thinkingTime) as
        | ThinkingTimeLevel
        | undefined,
      thinkingFallback: parsed.thinkingFallback ?? config.thinkingFallback,
      sandboxArtifactsOutputDir:
        parsed.sandboxArtifactsOutputDir ?? config.sandboxArtifactsOutputDir,
    },
    runtimeHintCb: createRuntimeHintCallback(context),
    beforeSend: () => context.markSubmission("submitting", { reasonCode: "submission_started" }),
    onPromptSubmitted: () =>
      context.markSubmission("accepted", { reasonCode: "submission_accepted" }),
    log: (message) => {
      void context.log(message);
    },
  });
  if (result.status === "submitted") {
    await context.markSubmission("accepted", { reasonCode: "submission_accepted" });
  } else if (result.submitted) {
    await context.markSubmission("submitted", { reasonCode: "submission_committed" });
  }
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
  await context.setPhase("submitting_prompt", "Submitting ChatGPT image turn.");
  const serviceOptions = {
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
        log: (message) => void context.log(message),
      }),
    createSession: (session: Parameters<typeof createChatgptSession>[0]) =>
      createChatgptSession({
        ...session,
        runtimeHintCb: createRuntimeHintCallback(context),
        beforeSend: () =>
          context.markSubmission("submitting", { reasonCode: "submission_started" }),
        onPromptSubmitted: () =>
          context.markSubmission("accepted", { reasonCode: "submission_accepted" }),
        log: (message) => {
          void context.log(message);
        },
      }),
  } as const;
  const operation = requireAttachments
    ? await editChatgptImage(serviceOptions)
    : await generateChatgptImage(serviceOptions);
  if (
    operation.state !== "completed" ||
    !operation.value ||
    typeof operation.value !== "object" ||
    !("turn" in operation.value) ||
    !Array.isArray(operation.outputs) ||
    operation.outputs.length < 1
  ) {
    throw new Error(
      `${operation.failure?.code ?? operation.state}: ${
        operation.failure?.message ?? "ChatGPT image operation did not produce an image artifact."
      }`,
    );
  }
  const generation = (operation.value as { turn: Awaited<ReturnType<typeof createChatgptSession>> })
    .turn;
  if (generation.status === "submitted") {
    await context.markSubmission("accepted", { reasonCode: "submission_accepted" });
  } else if (generation.submitted) {
    await context.markSubmission("submitted", { reasonCode: "submission_committed" });
  }
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
    await context.setPhase(
      "extracting_sandbox_artifacts",
      "Extracting generated sandbox artifacts.",
    );
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
  const images =
    extraction && extraction.images.length > 0
      ? extraction.images.map(({ domRecords: _domRecords, ...image }) => image)
      : (operation.outputs ?? []);
  const detectedImageCount = Math.max(
    extraction?.images.length ?? 0,
    operation.outputs?.length ?? 0,
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
    images,
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
      ...operation.warnings,
      ...extractionWarnings,
      ...(extraction?.warnings ?? []),
      ...(sandboxExtraction?.warnings ?? []),
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

const resolveDaemonBrowserConfig = resolveTrustedBrowserConfig;

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
