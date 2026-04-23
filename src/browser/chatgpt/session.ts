import path from "node:path";
import { connectToRemoteChrome, closeRemoteChromeTarget } from "../chromeLifecycle.js";
import { resolveBrowserConfig } from "../config.js";
import { CHATGPT_URL, CONVERSATION_TURN_SELECTOR, INPUT_SELECTORS } from "../constants.js";
import { navigateToChatGPT } from "../actions/navigation.js";
import { delay, estimateTokenCount } from "../utils.js";
import { runBrowserMode } from "../index.js";
import type {
  BrowserAttachment,
  BrowserAutomationConfig,
  BrowserLogger,
  ChromeClient,
} from "../types.js";
import {
  extractGeneratedImagesFromRuntime,
  snapshotChatgptPage,
} from "./imageArtifacts.js";
import { extractSandboxArtifactRefsFromRuntime } from "./sandboxArtifacts.js";
import type {
  ChatgptBrowserStatus,
  ChatgptAttachmentProbeResult,
  ChatgptConversationSnapshot,
  ChatgptConversationTurnSnapshot,
  ChatgptTurnResult,
} from "./types.js";
import {
  clearComposerAttachments,
  ensureLoggedIn,
  ensurePromptReady,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
} from "../pageActions.js";

export interface ChatgptBrowserStatusOptions {
  conversationUrl?: string;
  includeConversation?: boolean;
  config?: BrowserAutomationConfig;
  timeoutMs?: number;
  keepTab?: boolean;
  log?: BrowserLogger;
}

export interface ChatgptConversationSnapshotOptions {
  conversationUrl: string;
  config?: BrowserAutomationConfig;
  timeoutMs?: number;
  keepTab?: boolean;
  log?: BrowserLogger;
}

export interface ChatgptAttachmentProbeOptions {
  attachments: BrowserAttachment[];
  config?: BrowserAutomationConfig;
  timeoutMs?: number;
  keepTab?: boolean;
  log?: BrowserLogger;
}

export interface ChatgptSendTurnOptions {
  conversationUrl: string;
  prompt: string;
  attachments?: BrowserAttachment[];
  config?: BrowserAutomationConfig;
  timeoutMs?: number;
  includeSnapshot?: boolean;
  log?: BrowserLogger;
}

export interface ChatgptCreateSessionOptions {
  prompt: string;
  attachments?: BrowserAttachment[];
  config?: BrowserAutomationConfig;
  timeoutMs?: number;
  includeSnapshot?: boolean;
  log?: BrowserLogger;
}

export async function readChatgptBrowserStatus(
  options: ChatgptBrowserStatusOptions = {},
): Promise<ChatgptBrowserStatus> {
  const logger = options.log ?? ((_message: string) => {});
  const config = resolveBrowserConfig(options.config);
  const remoteChrome = config.remoteChrome;
  if (!remoteChrome) {
    throw new Error("ChatGPT browser status requires browser.remoteChrome or --remote-chrome.");
  }
  const targetUrl = options.conversationUrl ?? config.chatgptUrl ?? config.url ?? CHATGPT_URL;
  const connection = await connectToRemoteChrome(
    remoteChrome.host,
    remoteChrome.port,
    logger,
    targetUrl,
    { maxTabs: config.remoteChromeMaxTabs },
  );
  const client = connection.client;
  try {
    const { Page, Runtime } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    await navigateToChatGPT(Page, Runtime, targetUrl, logger);
    await waitForDocumentReady(Runtime, options.timeoutMs ?? 20_000);
    const page = await snapshotChatgptPage(Runtime);
    const status = page.loginLikely && page.hasComposer ? "ok" : "needs_login";
    const conversation =
      options.includeConversation && page.conversationId
        ? await waitForConversationSnapshot(Runtime, options.timeoutMs ?? 20_000)
        : undefined;
    return {
      remoteChrome,
      page,
      conversation,
      status,
      warnings: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      remoteChrome,
      page: {
        href: targetUrl,
        title: "",
        readyState: "",
        hasComposer: false,
        loginLikely: false,
        imageNodeCount: 0,
        generatedImageNodeCount: 0,
        uniqueGeneratedImageCount: 0,
      },
      status: "unavailable",
      warnings: [message],
    };
  } finally {
    try {
      await client.close();
    } finally {
      if (!options.keepTab) {
        await closeRemoteChromeTarget(
          remoteChrome.host,
          remoteChrome.port,
          connection.targetId,
          logger,
        );
      }
    }
  }
}

export async function probeChatgptAttachments(
  options: ChatgptAttachmentProbeOptions,
): Promise<ChatgptAttachmentProbeResult> {
  const logger = options.log ?? ((_message: string) => {});
  const config = resolveBrowserConfig(options.config);
  const remoteChrome = config.remoteChrome;
  if (!remoteChrome) {
    throw new Error("ChatGPT attachment probe requires browser.remoteChrome or --remote-chrome.");
  }
  const attachments = options.attachments ?? [];
  if (attachments.length === 0) {
    throw new Error("At least one attachment is required for an attachment probe.");
  }

  const connection = await connectToRemoteChrome(
    remoteChrome.host,
    remoteChrome.port,
    logger,
    config.chatgptUrl ?? config.url ?? CHATGPT_URL,
    { maxTabs: config.remoteChromeMaxTabs },
  );
  const client = connection.client;
  let cleared = false;
  try {
    const { Page, Runtime, DOM, Input } = client;
    await Promise.all([
      Page.enable(),
      Runtime.enable(),
      DOM && typeof DOM.enable === "function" ? DOM.enable() : Promise.resolve(),
    ]);
    if (!DOM) {
      throw new Error("Chrome DOM domain unavailable while probing attachments.");
    }

    const timeoutMs = options.timeoutMs ?? config.inputTimeoutMs ?? 60_000;
    await navigateToChatGPT(Page, Runtime, config.chatgptUrl ?? config.url ?? CHATGPT_URL, logger);
    await waitForDocumentReady(Runtime, Math.min(timeoutMs, 30_000));
    await ensureLoggedIn(Runtime, logger, { remoteSession: true });
    await ensurePromptReady(Runtime, timeoutMs, logger);
    await clearComposerAttachments(Runtime, 5_000, logger);

    for (let attachmentIndex = 0; attachmentIndex < attachments.length; attachmentIndex += 1) {
      const attachment = attachments[attachmentIndex];
      logger(`Probe uploading attachment: ${attachment.displayPath}`);
      await uploadAttachmentFile(
        { runtime: Runtime, dom: DOM, input: Input },
        attachment,
        logger,
        { expectedCount: attachmentIndex + 1 },
      );
      await delay(300);
    }

    const attachmentNames = attachments.map((attachment) => path.basename(attachment.path));
    const waitBudget = Math.max(timeoutMs, 30_000) + Math.max(0, attachments.length - 1) * 10_000;
    await waitForAttachmentCompletion(Runtime, waitBudget, attachmentNames, logger);
    await clearComposerAttachments(Runtime, 10_000, logger);
    cleared = true;
    const page = await snapshotChatgptPage(Runtime);
    return {
      remoteChrome,
      page,
      plannedAttachments: attachments.map((attachment) => ({
        path: attachment.path,
        displayPath: attachment.displayPath,
        sizeBytes: attachment.sizeBytes,
      })),
      uploadedNames: attachmentNames,
      cleared,
      warnings: [],
    };
  } finally {
    if (!cleared) {
      await clearComposerAttachments(client.Runtime, 5_000, logger).catch(() => undefined);
    }
    try {
      await client.close();
    } finally {
      if (!options.keepTab) {
        await closeRemoteChromeTarget(
          remoteChrome.host,
          remoteChrome.port,
          connection.targetId,
          logger,
        );
      }
    }
  }
}

export async function readChatgptConversationSnapshot(
  options: ChatgptConversationSnapshotOptions,
): Promise<ChatgptConversationSnapshot> {
  const logger = options.log ?? ((_message: string) => {});
  const config = resolveBrowserConfig(options.config);
  const remoteChrome = config.remoteChrome;
  if (!remoteChrome) {
    throw new Error("ChatGPT conversation snapshot requires browser.remoteChrome or --remote-chrome.");
  }
  const connection = await connectToRemoteChrome(
    remoteChrome.host,
    remoteChrome.port,
    logger,
    options.conversationUrl,
    { maxTabs: config.remoteChromeMaxTabs },
  );
  const client = connection.client;
  try {
    const { Page, Runtime } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    await navigateToChatGPT(Page, Runtime, options.conversationUrl, logger);
    await waitForDocumentReady(Runtime, options.timeoutMs ?? 30_000);
    return await waitForConversationSnapshot(Runtime, options.timeoutMs ?? 30_000);
  } finally {
    try {
      await client.close();
    } finally {
      if (!options.keepTab) {
        await closeRemoteChromeTarget(
          remoteChrome.host,
          remoteChrome.port,
          connection.targetId,
          logger,
        );
      }
    }
  }
}

export async function sendChatgptTurn(
  options: ChatgptSendTurnOptions,
): Promise<ChatgptTurnResult> {
  const baselineSnapshot = options.includeSnapshot
    ? await readChatgptConversationSnapshot({
        conversationUrl: options.conversationUrl,
        config: options.config,
        timeoutMs: Math.min(options.timeoutMs ?? 30_000, 30_000),
        log: options.log,
      }).catch(() => null)
    : null;
  const config = resolveBrowserConfig({
    ...(options.config ?? {}),
    url: options.conversationUrl,
    chatgptUrl: options.conversationUrl,
    modelStrategy: options.config?.modelStrategy ?? "current",
    timeoutMs: options.timeoutMs ?? options.config?.timeoutMs,
    inputTimeoutMs: resolveDirectChatInputTimeoutMs(options.timeoutMs, options.config),
  });
  const result = await runBrowserMode({
    prompt: options.prompt,
    attachments: options.attachments ?? [],
    config,
    log: options.log,
  });
  const snapshot =
    options.includeSnapshot && result.tabUrl
      ? await readChatgptConversationSnapshot({
          conversationUrl: result.tabUrl,
          config: options.config,
          timeoutMs: Math.min(options.timeoutMs ?? 30_000, 30_000),
          log: options.log,
        }).catch(() => undefined)
      : undefined;
  const baselineImageIds = new Set(
    baselineSnapshot?.generatedImages.map((image) => image.fileId) ?? [],
  );
  const generatedImages = snapshot?.generatedImages ?? [];
  const reconciledAnswer = reconcileAnswerWithSnapshot(result, snapshot);
  return {
    status: "completed",
    conversationUrl: result.tabUrl,
    answerText: reconciledAnswer.answerText,
    answerMarkdown: reconciledAnswer.answerMarkdown,
    tookMs: result.tookMs,
    answerChars: reconciledAnswer.answerText.length,
    answerTokens: estimateTokenCount(reconciledAnswer.answerText),
    chromeHost: result.chromeHost,
    chromePort: result.chromePort,
    chromeTargetId: result.chromeTargetId,
    snapshot,
    generatedImages,
    newGeneratedImages: generatedImages.filter((image) => !baselineImageIds.has(image.fileId)),
    sandboxArtifacts: result.sandboxArtifacts ?? snapshot?.sandboxArtifacts ?? [],
    newSandboxArtifacts:
      result.newSandboxArtifacts ??
      (snapshot?.sandboxArtifacts ?? []).filter(
        (artifact) =>
          !(baselineSnapshot?.sandboxArtifacts ?? []).some(
            (baseline) =>
              baseline.messageId === artifact.messageId &&
              baseline.documentIndex === artifact.documentIndex &&
              baseline.label === artifact.label,
          ),
      ),
    downloadedSandboxArtifacts: result.downloadedSandboxArtifacts ?? [],
    warnings: result.warnings ?? [],
  };
}

export async function createChatgptSession(
  options: ChatgptCreateSessionOptions,
): Promise<ChatgptTurnResult> {
  const config = resolveBrowserConfig({
    ...(options.config ?? {}),
    url: options.config?.url ?? options.config?.chatgptUrl ?? CHATGPT_URL,
    chatgptUrl: options.config?.chatgptUrl ?? options.config?.url ?? CHATGPT_URL,
    timeoutMs: options.timeoutMs ?? options.config?.timeoutMs,
    inputTimeoutMs: resolveDirectChatInputTimeoutMs(options.timeoutMs, options.config),
  });
  const result = await runBrowserMode({
    prompt: options.prompt,
    attachments: options.attachments ?? [],
    config,
    log: options.log,
  });
  const snapshot =
    options.includeSnapshot && result.tabUrl
      ? await readChatgptConversationSnapshot({
          conversationUrl: result.tabUrl,
          config: options.config,
          timeoutMs: Math.min(options.timeoutMs ?? 30_000, 30_000),
          log: options.log,
        }).catch(() => undefined)
      : undefined;
  const reconciledAnswer = reconcileAnswerWithSnapshot(result, snapshot);
  return {
    status: "completed",
    conversationUrl: result.tabUrl,
    answerText: reconciledAnswer.answerText,
    answerMarkdown: reconciledAnswer.answerMarkdown,
    tookMs: result.tookMs,
    answerChars: reconciledAnswer.answerText.length,
    answerTokens: estimateTokenCount(reconciledAnswer.answerText),
    chromeHost: result.chromeHost,
    chromePort: result.chromePort,
    chromeTargetId: result.chromeTargetId,
    snapshot,
    generatedImages: snapshot?.generatedImages ?? [],
    newGeneratedImages: snapshot?.generatedImages ?? [],
    sandboxArtifacts: result.sandboxArtifacts ?? snapshot?.sandboxArtifacts ?? [],
    newSandboxArtifacts: result.newSandboxArtifacts ?? result.sandboxArtifacts ?? [],
    downloadedSandboxArtifacts: result.downloadedSandboxArtifacts ?? [],
    warnings: result.warnings ?? [],
  };
}

function resolveDirectChatInputTimeoutMs(
  timeoutMs: number | undefined,
  config: BrowserAutomationConfig | undefined,
): number | undefined {
  const configured = config?.inputTimeoutMs;
  if (!timeoutMs || timeoutMs <= 0) {
    return configured;
  }
  const bounded = Math.max(15_000, Math.min(45_000, Math.floor(timeoutMs * 0.25)));
  return configured ? Math.min(configured, bounded) : bounded;
}

function reconcileAnswerWithSnapshot(
  result: { answerText: string; answerMarkdown: string },
  snapshot?: ChatgptConversationSnapshot,
): { answerText: string; answerMarkdown: string } {
  const latestText = snapshot?.latestAssistantTurn?.text?.trim();
  if (!latestText) {
    return { answerText: result.answerText, answerMarkdown: result.answerMarkdown };
  }
  const answerText = result.answerText.trim();
  const answerMarkdown = result.answerMarkdown.trim();
  const currentBestLength = Math.max(answerText.length, answerMarkdown.length);
  const currentLooksWrapped =
    /^chatgpt said:/i.test(answerText) || /^chatgpt said:/i.test(answerMarkdown);
  const latestLooksClean = !/^chatgpt said:/i.test(latestText);
  if ((currentLooksWrapped && latestLooksClean) || latestText.length > currentBestLength) {
    return { answerText: latestText, answerMarkdown: `${latestText}\n` };
  }
  return { answerText: result.answerText, answerMarkdown: result.answerMarkdown };
}

export async function readConversationSnapshotFromRuntime(
  Runtime: ChromeClient["Runtime"],
): Promise<ChatgptConversationSnapshot> {
  const [page, turns, generatedImages, sandboxArtifacts] = await Promise.all([
    snapshotChatgptPage(Runtime),
    readTurnsFromRuntime(Runtime),
    extractGeneratedImagesFromRuntime(Runtime),
    extractSandboxArtifactRefsFromRuntime(Runtime),
  ]);
  const latestAssistantTurn = findLastTurnByRole(turns, "assistant");
  const latestUserTurn = findLastTurnByRole(turns, "user");
  return {
    page: {
      ...page,
      generatedImageNodeCount: generatedImages.reduce(
        (sum, image) => sum + image.duplicateNodeCount,
        0,
      ),
      uniqueGeneratedImageCount: generatedImages.length,
    },
    turns,
    generatedImages,
    sandboxArtifacts,
    latestAssistantTurn,
    latestUserTurn,
    warnings: [],
  };
}

function findLastTurnByRole(
  turns: ChatgptConversationTurnSnapshot[],
  role: ChatgptConversationTurnSnapshot["role"],
): ChatgptConversationTurnSnapshot | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.role === role) {
      return turn;
    }
  }
  return undefined;
}

async function waitForConversationSnapshot(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
): Promise<ChatgptConversationSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = await readConversationSnapshotFromRuntime(Runtime);
  let lastKey = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    const key = [
      lastSnapshot.turns.length,
      lastSnapshot.generatedImages.map((image) => image.fileId).join("|"),
      lastSnapshot.sandboxArtifacts.map((artifact) => artifact.label).join("|"),
      lastSnapshot.latestAssistantTurn?.text ?? "",
    ].join(":");
    if (
      lastSnapshot.turns.length > 0 ||
      lastSnapshot.generatedImages.length > 0 ||
      lastSnapshot.sandboxArtifacts.length > 0
    ) {
      if (key === lastKey) {
        if (stableSince === 0) stableSince = Date.now();
        if (Date.now() - stableSince >= 5_000) {
          return lastSnapshot;
        }
      } else {
        stableSince = 0;
        lastKey = key;
      }
    }
    await delay(400);
    lastSnapshot = await readConversationSnapshotFromRuntime(Runtime);
  }
  return lastSnapshot;
}

async function readTurnsFromRuntime(
  Runtime: ChromeClient["Runtime"],
): Promise<ChatgptConversationTurnSnapshot[]> {
  const { result } = await Runtime.evaluate({
    expression: buildTurnSnapshotExpression(),
    returnByValue: true,
  });
  const value = result?.value;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): ChatgptConversationTurnSnapshot[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Partial<ChatgptConversationTurnSnapshot>;
    const role =
      item.role === "user" || item.role === "assistant" || item.role === "unknown"
        ? item.role
        : "unknown";
    const text = typeof item.text === "string" ? item.text : "";
    return [
      {
        index: typeof item.index === "number" ? item.index : 0,
        role,
        turnId: typeof item.turnId === "string" ? item.turnId : null,
        messageId: typeof item.messageId === "string" ? item.messageId : null,
        text,
        textPreview:
          typeof item.textPreview === "string" ? item.textPreview : text.slice(0, 240),
        generatedImageFileIds: Array.isArray(item.generatedImageFileIds)
          ? item.generatedImageFileIds.filter((id): id is string => typeof id === "string")
          : [],
        attachmentLabels: Array.isArray(item.attachmentLabels)
          ? item.attachmentLabels.filter((label): label is string => typeof label === "string")
          : [],
        sandboxArtifactLabels: Array.isArray(item.sandboxArtifactLabels)
          ? item.sandboxArtifactLabels.filter((label): label is string => typeof label === "string")
          : [],
      },
    ];
  });
}

async function waitForDocumentReady(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: "document.readyState",
      returnByValue: true,
    });
    if (result?.value === "interactive" || result?.value === "complete") {
      return;
    }
    await delay(250);
  }
}

function buildTurnSnapshotExpression(): string {
  return `(() => {
    const TURN_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
    const INPUT_SELECTORS = ${JSON.stringify(INPUT_SELECTORS)};
    const fileIdFor = (src) => {
      try {
        const url = new URL(src, location.href);
        const id = (url.searchParams.get("id") || "").trim();
        if (!/^file_[A-Za-z0-9]+$/.test(id)) return null;
        if (!url.pathname.includes("/backend-api/estuary/")) return null;
        return id;
      } catch {
        return null;
      }
    };
    const roleFor = (turn) => {
      const attr = [
        turn.getAttribute("data-message-author-role"),
        turn.getAttribute("data-turn"),
        turn.querySelector("[data-message-author-role]")?.getAttribute("data-message-author-role"),
        turn.querySelector("[data-turn]")?.getAttribute("data-turn")
      ].filter(Boolean).join(" ").toLowerCase();
      if (attr.includes("user")) return "user";
      if (attr.includes("assistant")) return "assistant";
      const text = (turn.textContent || "").trim();
      if (/^you said[:\\s]/i.test(text)) return "user";
      if (/^chatgpt said[:\\s]/i.test(text)) return "assistant";
      const hasComposer = INPUT_SELECTORS.some((selector) => turn.querySelector(selector));
      return hasComposer ? "user" : "unknown";
    };
    return Array.from(document.querySelectorAll(TURN_SELECTOR)).map((turn, index) => {
      const text = (turn.innerText || turn.textContent || "").replace(/\\s+/g, " ").trim();
      const imageIds = Array.from(new Set(
        Array.from(turn.querySelectorAll("img"))
          .map((img) => fileIdFor(img.currentSrc || img.src || ""))
          .filter(Boolean)
      ));
      const attachmentLabels = Array.from(turn.querySelectorAll('[data-testid*="attachment"], [aria-label*="attachment" i]'))
        .map((node) => (node.textContent || node.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim())
        .filter(Boolean);
      const inferredLabels = Array.from(text.matchAll(/([^\\s]+\\.(?:txt|md|json|csv|zip|png|jpe?g|webp|gif|svg|pdf))\\s+(?:Document|Image|File|PDF|Spreadsheet)\\b/gi))
        .map((match) => match[1])
        .filter(Boolean);
      const allAttachmentLabels = Array.from(new Set([...attachmentLabels, ...inferredLabels])).slice(0, 20);
      const sandboxArtifactLabels = Array.from(new Set(
        Array.from(turn.querySelectorAll(".markdown button.behavior-btn.entity-underline"))
          .map((node) => (node.textContent || "").replace(/\\s+/g, " ").trim())
          .filter(Boolean)
      )).slice(0, 20);
      return {
        index,
        role: roleFor(turn),
        turnId: turn.getAttribute("data-testid") || turn.id || null,
        messageId: turn.getAttribute("data-message-id") || null,
        text,
        textPreview: text.slice(0, 240),
        generatedImageFileIds: imageIds,
        attachmentLabels: allAttachmentLabels,
        sandboxArtifactLabels
      };
    });
  })()`;
}
