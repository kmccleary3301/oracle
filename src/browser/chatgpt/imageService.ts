import crypto from "node:crypto";
import path from "node:path";
import { connectToRemoteChrome, closeRemoteChromeTarget } from "../chromeLifecycle.js";
import type { RemoteChromeConnection } from "../chromeLifecycle.js";
import { resolveBrowserConfig } from "../config.js";
import { navigateToChatGPT } from "../actions/navigation.js";
import { delay } from "../utils.js";
import { CHATGPT_URL } from "../constants.js";
import type {
  BrowserAttachment,
  BrowserAutomationConfig,
  BrowserLogger,
  ChromeClient,
} from "../types.js";
import {
  bindApprovalChallenge,
  createApprovalChallenge,
  type ApprovalChallenge,
} from "../approvalToken.js";
import { createChatgptSession, type ChatgptCreateSessionOptions } from "./session.js";
import type { ChatgptGeneratedImage, ChatgptTurnResult } from "./types.js";
import {
  dedupeGeneratedImageRecords,
  downloadGeneratedImages,
  extractChatgptImagesFromConfiguredBrowser,
  extractGeneratedImagesFromRuntime,
  snapshotChatgptPage,
  type ExtractChatgptImagesOptions,
} from "./imageArtifacts.js";
import type {
  ChatgptImageArtifact,
  ChatgptImageAspectMetadata,
  ChatgptImageFailure,
  ChatgptImageHistory,
  ChatgptImageHistoryEntry,
  ChatgptImageInterruptResult,
  ChatgptImageLibraryEntry,
  ChatgptImageLibraryResult,
  ChatgptImageModeEvidence,
  ChatgptImageOperationResult,
  ChatgptImageOrigin,
  ChatgptImageOutput,
  ChatgptImageSourceSelection,
  ChatgptImageTarget,
  ChatgptImageApprovalOptions,
} from "./imageTypes.js";

export type {
  ChatgptImageArtifact,
  ChatgptImageAspectMetadata,
  ChatgptImageFailure,
  ChatgptImageHistory,
  ChatgptImageHistoryEntry,
  ChatgptImageInterruptResult,
  ChatgptImageLibraryEntry,
  ChatgptImageLibraryResult,
  ChatgptImageModeEvidence,
  ChatgptImageOperationResult,
  ChatgptImageOrigin,
  ChatgptImageOutput,
  ChatgptImageSourceSelection,
  ChatgptImageTarget,
} from "./imageTypes.js";

const IMAGE_MODE = "images";
const IMAGE_MODE_LABELS = new Set(["images", "image", "create images", "image generation"]);
const DEFAULT_IMAGE_LIBRARY_URL = "https://chatgpt.com/images";

export interface ImageModeObservation {
  selectedMode?: unknown;
  availableModes?: unknown;
  pageIdentity?: unknown;
  loginLikely?: unknown;
  controls?: { modes?: unknown };
}

export interface ChatgptImageRequestMetadata {
  aspectRatio?: string;
  count?: number;
}

export interface ChatgptImageServiceOptions {
  prompt: string;
  attachments?: BrowserAttachment[];
  config?: BrowserAutomationConfig;
  timeoutMs?: number;
  includeSnapshot?: boolean;
  aspectRatio?: string;
  count?: number;
  modeEvidence?: ChatgptImageModeEvidence;
  requireVerifiedMode?: boolean;
  /**
   * Optional mode probe seam for callers that already own browser setup (and tests).
   * The probe runs before createSession, so a failed observation cannot submit.
   */
  verifyMode?: () => Promise<ChatgptImageModeEvidence>;
  origin?: ChatgptImageOrigin;
  log?: BrowserLogger;
  /** Test/integration seam for durable callers that own their session wrapper. */
  createSession?: (options: ChatgptCreateSessionOptions) => Promise<ChatgptTurnResult>;
}

export interface ChatgptImageEditOptions extends ChatgptImageServiceOptions {
  target?: ChatgptImageTarget;
  existingImages?: ChatgptImageOutput[];
}

export interface ChatgptImageDownloadOptions {
  Runtime: ChromeClient["Runtime"];
  images: ChatgptImageOutput[];
  target?: ChatgptImageTarget;
  outputDir: string;
  origin?: ChatgptImageOrigin;
}

export interface ChatgptImageLibraryOptions {
  conversationUrl?: string;
  libraryUrl?: string;
  outputDir?: string;
  config?: BrowserAutomationConfig;
  timeoutMs?: number;
  keepTab?: boolean;
  log?: BrowserLogger;
}

function cleanMode(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ");
}

function safePageIdentity(value: unknown): ChatgptImageModeEvidence["pageIdentity"] {
  return value === "chatgpt_app" || value === "auth" || value === "challenge" || value === "other"
    ? value
    : "unknown";
}

function safeModes(value: unknown): string[] {
  const input = Array.isArray(value) ? value : [];
  return [...new Set(input.map(cleanMode).filter(Boolean))].sort();
}

/** Normalize only public DOM capability labels; never copy arbitrary DOM text. */
export function normalizeImageModeObservation(value: unknown): ChatgptImageModeEvidence {
  const observation = (value && typeof value === "object" ? value : {}) as ImageModeObservation;
  const controls =
    observation.controls && typeof observation.controls === "object" ? observation.controls : {};
  const availableModes = safeModes(observation.availableModes ?? controls.modes);
  const selectedMode = cleanMode(observation.selectedMode) || null;
  const pageIdentity = safePageIdentity(observation.pageIdentity);
  const loginLikely = Boolean(observation.loginLikely);
  const supported = availableModes.some((mode) => IMAGE_MODE_LABELS.has(mode));
  const verified =
    pageIdentity === "chatgpt_app" &&
    loginLikely &&
    IMAGE_MODE_LABELS.has(selectedMode ?? "") &&
    supported;
  return {
    supported,
    verified,
    selectedMode,
    availableModes,
    pageIdentity,
    loginLikely,
    source: "dom",
    ...(verified
      ? {}
      : {
          reason: !loginLikely
            ? "ChatGPT image mode requires a logged-in app page."
            : !supported
              ? "The Images mode is not exposed by the current UI/account."
              : "The current selected mode is not exactly Images.",
        }),
  };
}

export function imageModeEvidenceFromCapability(capability: {
  controls?: { modes?: string[] };
  page?: { identityClass?: string };
  auth?: { state?: string };
}): ChatgptImageModeEvidence {
  const pageIdentity = safePageIdentity(capability.page?.identityClass);
  const availableModes = safeModes(capability.controls?.modes);
  const loginLikely = capability.auth?.state === "logged_in";
  return {
    supported: availableModes.includes(IMAGE_MODE),
    verified: false,
    selectedMode: null,
    availableModes,
    pageIdentity,
    loginLikely,
    source: "capability",
    reason: "Capability metadata lists available modes but does not prove the selected mode.",
  };
}

export function isExactImageModeEvidence(
  evidence: ChatgptImageModeEvidence | null | undefined,
): boolean {
  return Boolean(evidence?.verified && cleanMode(evidence.selectedMode) === IMAGE_MODE);
}

export function buildImageModeVerificationExpression(): string {
  return `(() => {
    const normalize = (value) => String(value || '').trim().toLowerCase().replace(/[\\u2013\\u2014]/g, '-').replace(/\\s+/g, ' ');
    const labels = (node) => normalize(node?.getAttribute?.('aria-label') || node?.getAttribute?.('data-mode') || node?.innerText || node?.textContent || '');
    const modeNodes = Array.from(document.querySelectorAll('[data-mode],[data-testid*="mode" i],[aria-label*="image" i],button,[role="option"],[role="menuitem"]'));
    const availableModes = [...new Set(modeNodes.map(labels).filter(Boolean).filter((label) => /image|chat|search|research|work/.test(label)))];
    const selected = modeNodes.find((node) => node.getAttribute?.('aria-current') === 'true' || node.getAttribute?.('aria-selected') === 'true' || node.getAttribute?.('data-state') === 'checked');
    const selectedMode = labels(selected) || labels(document.querySelector('[data-testid="mode-switcher-dropdown-button"],[data-testid*="mode-switcher" i]')) || null;
    const pathname = String(location.pathname || '').toLowerCase();
    const body = String(document.body?.innerText || '');
    const pageIdentity = /\\/(auth|login)\\b/.test(pathname) ? 'auth' : /challenge|verify you are human/i.test(body) ? 'challenge' : /chatgpt\\.com/.test(location.hostname) ? 'chatgpt_app' : 'other';
    return { selectedMode, availableModes, pageIdentity, loginLikely: pageIdentity === 'chatgpt_app' && !/sign in|log in/i.test(body) };
  })()`;
}

export async function verifyChatgptImageMode(
  Runtime: ChromeClient["Runtime"],
): Promise<ChatgptImageModeEvidence> {
  try {
    const { result, exceptionDetails } = await Runtime.evaluate({
      expression: buildImageModeVerificationExpression(),
      returnByValue: true,
    });
    if (exceptionDetails) {
      return unsupportedModeEvidence("Image-mode inspection failed.");
    }

    return normalizeImageModeObservation(result?.value);
  } catch {
    return unsupportedModeEvidence("Image-mode inspection is unavailable.");
  }
}
export interface ChatgptImageModePreflightOptions {
  config?: BrowserAutomationConfig;
  timeoutMs?: number;
  log?: BrowserLogger;
}

/**
 * Observe the public mode controls in a configured browser before an image turn.
 * A preflight failure is represented as unsupported evidence, never as an
 * implicit permission to submit in Chat mode.
 */
export async function verifyChatgptImageModeFromConfiguredBrowser(
  options: ChatgptImageModePreflightOptions = {},
): Promise<ChatgptImageModeEvidence> {
  const logger = options.log ?? ((_message: string) => {});
  const config = resolveBrowserConfig(options.config);
  const remoteChrome = config.remoteChrome;
  if (!remoteChrome) {
    return unsupportedModeEvidence("ChatGPT image mode requires a configured logged-in browser.");
  }
  const targetUrl = config.chatgptUrl ?? config.url ?? CHATGPT_URL;
  let connection: RemoteChromeConnection | undefined;
  try {
    connection = await connectToRemoteChrome(
      remoteChrome.host,
      remoteChrome.port,
      logger,
      targetUrl,
      undefined,
      { maxTabs: config.remoteChromeMaxTabs },
    );
    const { Runtime, Page } = connection.client;
    await Promise.all([Runtime.enable(), Page.enable()]);
    await navigateToChatGPT(Page, Runtime, targetUrl, logger);
    const deadline = Date.now() + Math.min(options.timeoutMs ?? 30_000, 30_000);
    while (Date.now() < deadline) {
      const page = await snapshotChatgptPage(Runtime);
      if (page.readyState === "interactive" || page.readyState === "complete") break;
      await delay(100);
    }
    return await verifyChatgptImageMode(Runtime);
  } catch {
    return unsupportedModeEvidence("Image-mode inspection is unavailable.");
  } finally {
    if (connection) {
      try {
        await connection.client.close();
      } finally {
        await closeRemoteChromeTarget(
          remoteChrome.host,
          remoteChrome.port,
          connection.targetId,
          logger,
        ).catch(() => undefined);
      }
    }
  }
}

function unsupportedModeEvidence(reason: string): ChatgptImageModeEvidence {
  return {
    supported: false,
    verified: false,
    selectedMode: null,
    availableModes: [],
    pageIdentity: "unknown",
    loginLikely: false,
    source: "dom",
    reason,
  };
}

export function sanitizeImageOutput(
  image: ChatgptGeneratedImage,
  outputIndex = image.variantIndex,
  origin?: ChatgptImageOrigin,
): ChatgptImageOutput {
  const { domRecords: _domRecords, ...safe } = image;
  return {
    ...safe,
    outputIndex,
    ...(origin ? { origin } : {}),
  };
}

/** Stable, deterministic output ordering and file-id dedupe across partial DOM snapshots. */
export function stableOrderAndDedupeImages(
  images: ChatgptGeneratedImage[] | ChatgptImageOutput[],
  origin?: ChatgptImageOrigin,
): ChatgptImageOutput[] {
  const byId = new Map<string, ChatgptGeneratedImage | ChatgptImageOutput>();
  images.forEach((image) => {
    const key = image.fileId || image.sourceUrl;
    const current = byId.get(key);
    if (!current) {
      byId.set(key, image);
      return;
    }
    const area = (image.renderedWidth || 0) * (image.renderedHeight || 0);
    const currentArea = (current.renderedWidth || 0) * (current.renderedHeight || 0);
    if (area > currentArea) byId.set(key, image);
  });
  return [...byId.values()]
    .map((image, index) => {
      const inheritedOrigin = "origin" in image ? image.origin : undefined;
      return sanitizeImageOutput(image as ChatgptGeneratedImage, index, origin ?? inheritedOrigin);
    })
    .sort((a, b) => {
      const at = a.turnIndex ?? Number.MAX_SAFE_INTEGER;
      const bt = b.turnIndex ?? Number.MAX_SAFE_INTEGER;
      return at - bt || a.outputIndex - b.outputIndex || a.fileId.localeCompare(b.fileId);
    })
    .map((image, index) => ({ ...image, outputIndex: index, variantIndex: index }));
}

export function selectImageSource(
  images: ChatgptImageOutput[],
  target?: ChatgptImageTarget,
): ChatgptImageSourceSelection {
  const candidates = target?.fileId
    ? images.filter((image) => {
        if (image.fileId !== target.fileId) return false;
        if (target.turnId != null && image.turnId !== target.turnId) return false;
        if (target.messageId != null && image.messageId !== target.messageId) return false;
        return true;
      })
    : images;
  if (candidates.length === 1) {
    return { status: "selected", image: candidates[0], candidates };
  }
  if (candidates.length > 1) {
    return {
      status: "requires_action",
      candidates,
      reason:
        "Select an exact image file id, turn id, and message id before editing or downloading.",
    };
  }
  return {
    status: "not_found",
    candidates: [],
    reason: target?.fileId
      ? "The requested image target is no longer present."
      : "No generated images were found.",
  };
}

export function calculateImageAspect(width?: number, height?: number): string | undefined {
  if (!(width && height && width > 0 && height > 0)) return undefined;
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function gcd(left: number, right: number): number {
  let a = Math.abs(Math.round(left));
  let b = Math.abs(Math.round(right));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

export function classifyImageError(error: unknown): ChatgptImageFailure {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (/429|rate.?limit|too many requests|capacity/.test(lower)) {
    return {
      code: "rate_limit",
      message: "ChatGPT image generation is rate limited.",
      retryable: true,
    };
  }
  if (/disconnect|socket|target closed|connection reset|econn|browser.*unavailable/.test(lower)) {
    return {
      code: "disconnect",
      message: "The browser connection disconnected before the image turn completed.",
      retryable: true,
    };
  }
  if (/interrupt|cancel|stop/.test(lower)) {
    return {
      code: "interrupted",
      message: "The image operation was interrupted.",
      retryable: false,
    };
  }
  return {
    code: "browser_error",
    message: "The ChatGPT image operation failed.",
    retryable: false,
  };
}

export function requireVerifiedMode(
  operation: "generate" | "edit",
  evidence: ChatgptImageModeEvidence | undefined,
): ChatgptImageOperationResult<never> | undefined {
  if (!evidence || isExactImageModeEvidence(evidence)) return undefined;
  const code =
    evidence.pageIdentity === "auth" ||
    evidence.pageIdentity === "challenge" ||
    !evidence.loginLikely
      ? "login_required"
      : !evidence.supported
        ? "mode_unavailable"
        : "mode_unverified";
  return {
    operation,
    state: "unsupported",
    capability: evidence,
    warnings: [evidence.reason ?? "The current UI does not prove the exact Images mode."],
    failure: {
      code,
      message: evidence.reason ?? "Images mode is unavailable or unverified.",
      retryable: false,
      capability: evidence,
    },
  };
}

function buildMetadata(
  request: ChatgptImageRequestMetadata | undefined,
  outputs: ChatgptImageOutput[],
) {
  const aspect: ChatgptImageAspectMetadata | undefined = request?.aspectRatio
    ? {
        requested: request.aspectRatio,
        actual: calculateImageAspect(outputs[0]?.renderedWidth, outputs[0]?.renderedHeight),
      }
    : outputs[0]
      ? { actual: calculateImageAspect(outputs[0].renderedWidth, outputs[0].renderedHeight) }
      : undefined;
  return { aspect, count: { requested: request?.count, produced: outputs.length } };
}

export function imageOutputMetadata(
  request: ChatgptImageRequestMetadata | undefined,
  outputs: ChatgptImageOutput[],
) {
  return buildMetadata(request, outputs);
}
async function runSession(
  options: ChatgptImageServiceOptions,
  operation: "generate" | "edit",
): Promise<ChatgptImageOperationResult<unknown>> {
  let modeEvidence = options.modeEvidence;
  if (options.requireVerifiedMode === true && !modeEvidence) {
    try {
      modeEvidence = await (
        options.verifyMode ??
        (() =>
          verifyChatgptImageModeFromConfiguredBrowser({
            config: options.config,
            timeoutMs: options.timeoutMs,
            log: options.log,
          }))
      )();
    } catch {
      modeEvidence = unsupportedModeEvidence("Image-mode inspection is unavailable.");
    }
  }
  const evidenceFailure =
    options.requireVerifiedMode === true ? requireVerifiedMode(operation, modeEvidence) : undefined;
  if (evidenceFailure) return evidenceFailure;
  try {
    const create = options.createSession ?? createChatgptSession;
    const turn = await create({
      prompt: options.prompt,
      attachments: options.attachments,
      config: options.config,
      timeoutMs: options.timeoutMs,
      includeSnapshot: options.includeSnapshot ?? true,
      log: options.log,
    });
    const outputs = stableOrderAndDedupeImages(
      turn.newGeneratedImages?.length ? turn.newGeneratedImages : (turn.generatedImages ?? []),
      options.origin ?? {
        conversationUrl: turn.conversationUrl,
        turnId: turn.provenance?.at(-1)?.turnId,
        messageId: turn.provenance?.at(-1)?.messageId,
        turnIndex: turn.provenance?.at(-1)?.turnIndex,
      },
    );
    const metadata = buildMetadata(options, outputs);
    if (outputs.length === 0) {
      const message = "The completed turn did not produce a verified image artifact.";
      return {
        operation,
        state: "unsupported",
        capability: modeEvidence,
        warnings: [...turn.warnings, message],
        failure: {
          code: "no_image_artifacts",
          message,
          retryable: false,
          capability: modeEvidence,
        },
        origin: options.origin ?? { conversationUrl: turn.conversationUrl },
      };
    }
    return {
      operation,
      state: "completed",
      capability: modeEvidence,
      warnings: turn.warnings,
      outputs,
      value: { turn, metadata },
      origin: options.origin ?? { conversationUrl: turn.conversationUrl },
    };
  } catch (error) {
    const failure = classifyImageError(error);
    return {
      operation,
      state:
        failure.code === "rate_limit"
          ? "rate_limited"
          : failure.code === "disconnect"
            ? "disconnected"
            : failure.code === "interrupted"
              ? "interrupted"
              : "error",
      warnings: [failure.message],
      failure,
    };
  }
}

export async function generateChatgptImage(
  options: ChatgptImageServiceOptions,
): Promise<ChatgptImageOperationResult<unknown>> {
  return runSession(options, "generate");
}

export async function editChatgptImage(
  options: ChatgptImageEditOptions,
): Promise<ChatgptImageOperationResult<unknown>> {
  if (options.target && options.existingImages) {
    const selected = selectImageSource(options.existingImages, options.target);
    if (selected.status !== "selected") {
      return {
        operation: "edit",
        state: "requires_action",
        warnings: [selected.reason ?? "An exact edit target is required."],
        failure: {
          code: selected.status === "not_found" ? "target_not_found" : "target_ambiguous",
          message: selected.reason ?? "An exact edit target is required.",
          retryable: false,
        },
      };
    }
  }
  return runSession(options, "edit");
}

export async function getChatgptImage(
  images: ChatgptImageOutput[],
  target: ChatgptImageTarget,
): Promise<ChatgptImageOperationResult<ChatgptImageOutput>> {
  const selected = selectImageSource(images, target);
  if (selected.status !== "selected") {
    return {
      operation: "get",
      state: "requires_action",
      warnings: [selected.reason ?? "An exact image target is required."],
      failure: {
        code: selected.status === "not_found" ? "target_not_found" : "target_ambiguous",
        message: selected.reason ?? "Image target not found.",
        retryable: false,
      },
    };
  }
  const selectedImage = selected.image;
  if (!selectedImage) {
    return {
      operation: "get",
      state: "requires_action",
      warnings: ["An exact image target is required."],
      failure: { code: "target_not_found", message: "Image target not found.", retryable: false },
    };
  }
  return {
    operation: "get",
    state: "completed",
    value: selectedImage,
    outputs: [selectedImage],
    warnings: [],
  };
}

export async function downloadChatgptImage(
  options: ChatgptImageDownloadOptions,
): Promise<ChatgptImageOperationResult<ChatgptImageArtifact>> {
  const selected = selectImageSource(options.images, options.target);
  if (selected.status !== "selected") {
    return {
      operation: "download",
      state: "requires_action",
      warnings: [selected.reason ?? "An exact image target is required."],
      failure: {
        code: selected.status === "not_found" ? "target_not_found" : "target_ambiguous",
        message: selected.reason ?? "Image target not found.",
        retryable: false,
      },
    };
  }
  const selectedImage = selected.image;
  if (!selectedImage) {
    return {
      operation: "download",
      state: "requires_action",
      warnings: ["An exact image target is required."],
      failure: { code: "target_not_found", message: "Image target not found.", retryable: false },
    };
  }
  try {
    const [raw] = await downloadGeneratedImages(
      options.Runtime,
      [selectedImage as unknown as ChatgptGeneratedImage],
      options.outputDir,
    );
    const artifact: ChatgptImageArtifact = {
      ...raw,
      quality: "full",
      origin: options.origin ??
        selectedImage.origin ?? {
          turnId: selectedImage.turnId,
          messageId: selectedImage.messageId,
          turnIndex: selectedImage.turnIndex,
        },
    };
    return {
      operation: "download",
      state: "completed",
      value: artifact,
      artifacts: [artifact],
      outputs: [selectedImage],
      warnings: [],
    };
  } catch (error) {
    const failure = classifyImageError(error);
    return {
      operation: "download",
      state: failure.code === "disconnect" ? "disconnected" : "error",
      warnings: [failure.message],
      failure,
    };
  }
}

export function dedupeImageLibraryEntries(
  entries: ChatgptImageLibraryEntry[],
): ChatgptImageLibraryEntry[] {
  const byId = new Map<string, ChatgptImageLibraryEntry>();
  for (const entry of entries) {
    const current = byId.get(entry.fileId);
    if (!current || entry.outputIndex < current.outputIndex || (!current.sha256 && entry.sha256))
      byId.set(entry.fileId, entry);
  }
  return [...byId.values()].sort(
    (a, b) => a.outputIndex - b.outputIndex || a.fileId.localeCompare(b.fileId),
  );
}

export function normalizeImageLibraryEntries(value: unknown): ChatgptImageLibraryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries = value.flatMap((item): ChatgptImageLibraryEntry[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const fileId = typeof record.fileId === "string" ? record.fileId : "";
    const sourceUrl = typeof record.sourceUrl === "string" ? record.sourceUrl : "";
    if (!fileId || !sourceUrl) return [];
    const width = typeof record.renderedWidth === "number" ? record.renderedWidth : undefined;
    const height = typeof record.renderedHeight === "number" ? record.renderedHeight : undefined;
    return [
      {
        fileId,
        sourceUrl,
        turnId: typeof record.turnId === "string" ? record.turnId : null,
        messageId: typeof record.messageId === "string" ? record.messageId : null,
        turnIndex: typeof record.turnIndex === "number" ? record.turnIndex : null,
        variantIndex: typeof record.variantIndex === "number" ? record.variantIndex : 0,
        outputIndex: typeof record.outputIndex === "number" ? record.outputIndex : 0,
        renderedWidth: width ?? 0,
        renderedHeight: height ?? 0,
        isThumbnail: Boolean(record.isThumbnail),
        duplicateNodeCount:
          typeof record.duplicateNodeCount === "number" ? record.duplicateNodeCount : 1,
        ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
        ...(typeof record.byteSize === "number" ? { byteSize: record.byteSize } : {}),
        ...(typeof record.sha256 === "string" ? { sha256: record.sha256 } : {}),
        ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {}),
      },
    ];
  });
  return dedupeImageLibraryEntries(entries);
}

function buildLibraryExpression(): string {
  return `(() => {
    const rows = [];
    const seen = new Set();
    for (const image of Array.from(document.images)) {
      const src = image.currentSrc || image.src || '';
      let url;
      try { url = new URL(src, location.href); } catch { continue; }
      const fileId = url.searchParams.get('id') || (url.pathname.match(/\\/(file_[A-Za-z0-9]+)(?:\\/|$)/) || [])[1] || '';
      if (!/^file_[A-Za-z0-9]+$/.test(fileId) || seen.has(fileId)) continue;
      seen.add(fileId);
      const turn = image.closest('[data-testid^="conversation-turn-"]');
      const rect = image.getBoundingClientRect();
      const turnTestId = turn?.getAttribute('data-testid') || '';
      const match = turnTestId.match(/conversation-turn-(\\d+)/);
      rows.push({ fileId, sourceUrl: src, renderedWidth: Math.round(rect.width || image.naturalWidth || 0), renderedHeight: Math.round(rect.height || image.naturalHeight || 0), isThumbnail: false, duplicateNodeCount: 1, variantIndex: rows.length, outputIndex: rows.length, turnId: turnTestId || null, messageId: turn?.getAttribute('data-message-id') || null, turnIndex: match ? Number(match[1]) : null });
    }
    return rows;
  })()`;
}

export async function listChatgptImageLibrary(
  Runtime: ChromeClient["Runtime"],
): Promise<ChatgptImageLibraryResult> {
  try {
    const { result, exceptionDetails } = await Runtime.evaluate({
      expression: buildLibraryExpression(),
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error("Image library inspection failed.");
    const entries = normalizeImageLibraryEntries(result?.value);
    return { state: "completed", entries, warnings: [] };
  } catch {
    return {
      state: "partial",
      entries: [],
      warnings: ["Image library metadata is unavailable in the current UI."],
    };
  }
}

export async function listChatgptImageLibraryFromConfiguredBrowser(
  options: ChatgptImageLibraryOptions = {},
): Promise<ChatgptImageLibraryResult> {
  const logger = options.log ?? ((_message: string) => {});
  const config = resolveBrowserConfig(options.config);
  const remoteChrome = config.remoteChrome;
  if (!remoteChrome)
    return {
      state: "partial",
      entries: [],
      warnings: ["Image library requires a configured logged-in browser."],
    };
  const connection = await connectToRemoteChrome(
    remoteChrome.host,
    remoteChrome.port,
    logger,
    options.libraryUrl ?? DEFAULT_IMAGE_LIBRARY_URL,
    undefined,
    { maxTabs: config.remoteChromeMaxTabs },
  );
  try {
    const { Runtime, Page } = connection.client;
    await Promise.all([Runtime.enable(), Page.enable()]);
    await navigateToChatGPT(Page, Runtime, options.libraryUrl ?? DEFAULT_IMAGE_LIBRARY_URL, logger);
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      const page = await snapshotChatgptPage(Runtime);
      if (page.readyState === "interactive" || page.readyState === "complete") break;
      await delay(200);
    }
    return await listChatgptImageLibrary(Runtime);
  } catch {
    return {
      state: "partial",
      entries: [],
      warnings: ["Image library could not be read from the configured browser."],
    };
  } finally {
    try {
      await connection.client.close();
    } finally {
      if (!options.keepTab)
        await closeRemoteChromeTarget(
          remoteChrome.host,
          remoteChrome.port,
          connection.targetId,
          logger,
        );
    }
  }
}

export async function getChatgptImageLibraryEntry(
  Runtime: ChromeClient["Runtime"],
  target: ChatgptImageTarget,
): Promise<ChatgptImageOperationResult<ChatgptImageLibraryEntry>> {
  const listing = await listChatgptImageLibrary(Runtime);
  const result = await getChatgptImage(listing.entries, target);
  return { ...result, value: result.value as ChatgptImageLibraryEntry | undefined };
}

export function createImageHistory(): ChatgptImageHistory {
  return { entries: [], cursor: -1 };
}

export function appendImageHistory(
  history: ChatgptImageHistory,
  entry: Omit<ChatgptImageHistoryEntry, "createdAt"> & { createdAt?: string },
): ChatgptImageHistory {
  const entries = history.entries.slice(0, history.cursor + 1);
  entries.push({ ...entry, createdAt: entry.createdAt ?? new Date().toISOString() });
  return { entries, cursor: entries.length - 1 };
}

function historyAction(
  history: ChatgptImageHistory,
  operation: "undo" | "redo",
  options: ChatgptImageApprovalOptions = {},
): ChatgptImageOperationResult<ChatgptImageHistoryEntry | null> {
  const nextCursor = operation === "undo" ? history.cursor - 1 : history.cursor + 1;
  const current = history.entries[history.cursor];
  const target = current?.target;
  if (!target || !target.revisionHash)
    return {
      operation,
      state: "requires_action",
      warnings: ["An image revision target is required."],
      failure: {
        code: "target_not_found",
        message: "No image revision is selected.",
        retryable: false,
      },
    };
  const approvalChallenge = bindApprovalChallenge(
    createApprovalChallenge({ operation, target: target.fileId, revision: target.revisionHash }),
    options.approvalChallenge,
  );
  if (!options.approvalAuthority)
    return {
      operation,
      state: "requires_action",
      approvalChallenge,
      warnings: ["Approval authority is unavailable."],
      failure: {
        code: "approval_required",
        message: "An injected approval authority is required for image history changes.",
        retryable: false,
      },
    };
  const consumed = options.approvalAuthority.consumeGrant(options.approvalGrant, approvalChallenge);
  if (consumed.state !== "consumed")
    return {
      operation,
      state: "requires_action",
      approvalChallenge,
      warnings: ["Approval is required for image history changes."],
      failure: { code: "approval_required", message: consumed.reason, retryable: false },
    };
  const entry = history.entries[nextCursor];
  if (!entry) return { operation, state: "completed", value: null, warnings: [] };
  return { operation, state: "completed", value: entry, outputs: entry.outputs, warnings: [] };
}

export function undoImageHistory(
  history: ChatgptImageHistory,
  options?: ChatgptImageApprovalOptions,
) {
  return historyAction(history, "undo", options);
}

export function redoImageHistory(
  history: ChatgptImageHistory,
  options?: ChatgptImageApprovalOptions,
) {
  return historyAction(history, "redo", options);
}

export function approvalChallengeForImageHistory(
  operation: "undo" | "redo",
  target: ChatgptImageTarget,
): ApprovalChallenge | null {
  if (!target.revisionHash) return null;
  return createApprovalChallenge({
    operation,
    target: target.fileId,
    revision: target.revisionHash,
  });
}

export async function interruptChatgptImage(
  Runtime: ChromeClient["Runtime"],
  target: ChatgptImageTarget,
  options: ChatgptImageApprovalOptions & { confirm?: boolean } = {},
): Promise<ChatgptImageInterruptResult> {
  const approvalChallenge = target.revisionHash
    ? bindApprovalChallenge(
        createApprovalChallenge({
          operation: "interrupt",
          target: target.fileId,
          revision: target.revisionHash,
        }),
        options.approvalChallenge,
      )
    : undefined;
  if (!options.confirm)
    return {
      operation: "interrupt",
      state: "requires_action",
      target,
      stopped: false,
      ...(approvalChallenge ? { approvalChallenge } : {}),
      reason: "Interrupting an image turn requires explicit confirmation.",
    };
  if (!approvalChallenge)
    return {
      operation: "interrupt",
      state: "requires_action",
      target,
      stopped: false,
      reason: "Approval is required for this exact image turn.",
    };
  if (!options.approvalAuthority)
    return {
      operation: "interrupt",
      state: "requires_action",
      target,
      stopped: false,
      approvalChallenge,
      reason: "Approval authority is unavailable.",
    };
  const consumed = options.approvalAuthority.consumeGrant(options.approvalGrant, approvalChallenge);
  if (consumed.state !== "consumed")
    return {
      operation: "interrupt",
      state: "requires_action",
      target,
      stopped: false,
      approvalChallenge,
      reason: consumed.reason,
    };
  try {
    const { result } = await Runtime.evaluate({
      expression: `(() => { const buttons = Array.from(document.querySelectorAll('button')); const stop = buttons.find((button) => /stop|cancel/i.test(String(button.getAttribute('aria-label') || button.textContent || ''))); if (!stop) return false; stop.click(); return true; })()`,
      returnByValue: true,
    });
    return result?.value === true
      ? { operation: "interrupt", state: "interrupted", target, stopped: true, approvalChallenge }
      : {
          operation: "interrupt",
          state: "completed",
          target,
          stopped: false,
          approvalChallenge,
          reason: "No active image turn was found.",
        };
  } catch {
    return {
      operation: "interrupt",
      state: "requires_action",
      target,
      stopped: false,
      approvalChallenge,
      reason: "The browser disconnected before the interrupt could be confirmed.",
    };
  }
}

export interface ChatgptImageTurnPresentation {
  operation: "generate" | "edit";
  conversationUrl?: string;
  answerText: string;
  answerMarkdown: string;
  tookMs: number;
  newGeneratedImageCount: number;
  uniqueGeneratedImageCount: number;
  generatedImageNodeCount: number;
  outputDir?: string;
  images: ChatgptImageOutput[];
  artifacts: ChatgptImageArtifact[];
  warnings: string[];
}

export function formatChatgptImageTurn(
  operation: "generate" | "edit",
  turn: ChatgptTurnResult,
  extraction?: {
    page: { generatedImageNodeCount: number };
    images: ChatgptGeneratedImage[];
    artifacts: Array<{
      fileId: string;
      sourceUrl: string;
      downloadedPath: string;
      mimeType?: string;
      width?: number;
      height?: number;
      byteSize: number;
      sha256: string;
      variantIndex: number;
      downloadMethod: "browser-fetch";
    }>;
    outputDir?: string;
    warnings: string[];
  },
): ChatgptImageTurnPresentation {
  const rawImages = extraction?.images.length
    ? extraction.images
    : turn.newGeneratedImages?.length
      ? turn.newGeneratedImages
      : (turn.generatedImages ?? []);
  const origin: ChatgptImageOrigin = {
    conversationUrl: turn.conversationUrl,
    turnId: turn.provenance?.at(-1)?.turnId,
    messageId: turn.provenance?.at(-1)?.messageId,
    turnIndex: turn.provenance?.at(-1)?.turnIndex,
  };
  const images = stableOrderAndDedupeImages(rawImages, origin);
  const imageById = new Map(images.map((image) => [image.fileId, image]));
  const artifacts: ChatgptImageArtifact[] = (extraction?.artifacts ?? []).map((artifact) => ({
    ...artifact,
    quality: "full" as const,
    origin: {
      ...origin,
      ...(imageById.get(artifact.fileId)?.turnId !== undefined
        ? { turnId: imageById.get(artifact.fileId)?.turnId }
        : {}),
      ...(imageById.get(artifact.fileId)?.messageId !== undefined
        ? { messageId: imageById.get(artifact.fileId)?.messageId }
        : {}),
      ...(imageById.get(artifact.fileId)?.turnIndex !== undefined
        ? { turnIndex: imageById.get(artifact.fileId)?.turnIndex }
        : {}),
    },
  }));
  return {
    operation,
    conversationUrl: turn.conversationUrl,
    answerText: turn.answerText,
    answerMarkdown: turn.answerMarkdown,
    tookMs: turn.tookMs,
    newGeneratedImageCount: turn.newGeneratedImages?.length ?? images.length,
    uniqueGeneratedImageCount: images.length,
    generatedImageNodeCount:
      extraction?.page.generatedImageNodeCount ??
      images.reduce((sum, image) => sum + image.duplicateNodeCount, 0),
    outputDir: extraction?.outputDir,
    images,
    artifacts,
    warnings: [...turn.warnings, ...(extraction?.warnings ?? [])],
  };
}

export async function extractChatgptImageArtifacts(options: ExtractChatgptImagesOptions) {
  const result = await extractChatgptImagesFromConfiguredBrowser(options);
  return {
    ...result,
    images: stableOrderAndDedupeImages(result.images),
    artifacts: result.artifacts.map((artifact) => ({
      ...artifact,
      quality: "full" as const,
      origin: {
        conversationUrl: options.conversationUrl,
        turnId: result.images.find((image) => image.fileId === artifact.fileId)?.turnId,
        messageId: result.images.find((image) => image.fileId === artifact.fileId)?.messageId,
        turnIndex: result.images.find((image) => image.fileId === artifact.fileId)?.turnIndex,
      },
    })),
  };
}

export function sha256ImageBytes(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function imageArtifactFilename(fileId: string, mimeType?: string): string {
  const extension = mimeType?.includes("png")
    ? ".png"
    : mimeType?.includes("jpeg")
      ? ".jpg"
      : mimeType?.includes("webp")
        ? ".webp"
        : ".img";
  return path.join(`${fileId}${extension}`);
}

export { dedupeGeneratedImageRecords, extractGeneratedImagesFromRuntime };
