import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChromeClient, BrowserAutomationConfig, BrowserLogger } from "../types.js";
import { resolveBrowserConfig } from "../config.js";
import { connectToRemoteChrome, closeRemoteChromeTarget } from "../chromeLifecycle.js";
import { navigateToChatGPT } from "../actions/navigation.js";
import { delay } from "../utils.js";
import { CONVERSATION_TURN_SELECTOR, INPUT_SELECTORS } from "../constants.js";
import type {
  ChatgptDownloadedImageArtifact,
  ChatgptGeneratedImage,
  ChatgptImageDomRecord,
  ChatgptImageExtractionResult,
  ChatgptPageSnapshot,
} from "./types.js";

export interface ExtractChatgptImagesOptions {
  conversationUrl: string;
  outputDir?: string;
  download?: boolean;
  config?: BrowserAutomationConfig;
  log?: BrowserLogger;
  timeoutMs?: number;
  keepTab?: boolean;
}

export function extractGeneratedImageFileId(rawUrl: string): string | null {
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, "https://chatgpt.com/");
  } catch {
    return null;
  }
  const id = parsed.searchParams.get("id")?.trim() ?? "";
  if (/^file_[A-Za-z0-9]+$/.test(id)) {
    return id;
  }
  const pathMatch = parsed.pathname.match(/\/(file_[A-Za-z0-9]+)(?:\/|$)/);
  return pathMatch?.[1] ?? null;
}

export function isLikelyChatgptGeneratedImageUrl(rawUrl: string): boolean {
  const fileId = extractGeneratedImageFileId(rawUrl);
  if (!fileId) return false;
  try {
    const parsed = new URL(rawUrl, "https://chatgpt.com/");
    return parsed.hostname === "chatgpt.com" && parsed.pathname.includes("/backend-api/estuary/");
  } catch {
    return false;
  }
}

export function dedupeGeneratedImageRecords(
  records: ChatgptImageDomRecord[],
): ChatgptGeneratedImage[] {
  const groups = new Map<string, ChatgptImageDomRecord[]>();
  for (const record of records) {
    const existing = groups.get(record.fileId) ?? [];
    existing.push(record);
    groups.set(record.fileId, existing);
  }

  return Array.from(groups.entries())
    .map(([fileId, group]) => {
      const sorted = [...group].sort((a, b) => {
        const areaDelta = b.area - a.area;
        if (areaDelta !== 0) return areaDelta;
        return a.documentIndex - b.documentIndex;
      });
      const representative = sorted[0];
      const firstDocumentIndex = Math.min(...group.map((item) => item.documentIndex));
      return {
        fileId,
        sourceUrl: representative.src,
        turnId: representative.turnId,
        messageId: representative.messageId,
        turnIndex: representative.turnIndex,
        variantIndex: 0,
        renderedWidth: representative.renderedWidth,
        renderedHeight: representative.renderedHeight,
        isThumbnail: representative.isThumbnail,
        duplicateNodeCount: group.length,
        domRecords: group,
        firstDocumentIndex,
      };
    })
    .sort((a, b) => a.firstDocumentIndex - b.firstDocumentIndex)
    .map(({ firstDocumentIndex: _firstDocumentIndex, ...image }, index) => ({
      ...image,
      variantIndex: index,
    }));
}

export async function snapshotChatgptPage(
  Runtime: ChromeClient["Runtime"],
): Promise<ChatgptPageSnapshot> {
  const { result } = await Runtime.evaluate({
    expression: buildPageSnapshotExpression(),
    returnByValue: true,
  });
  return normalizePageSnapshot(result?.value);
}

export async function extractGeneratedImagesFromRuntime(
  Runtime: ChromeClient["Runtime"],
): Promise<ChatgptGeneratedImage[]> {
  const { result } = await Runtime.evaluate({
    expression: buildImageExtractionExpression(),
    returnByValue: true,
  });
  const records = normalizeDomRecords(result?.value);
  return dedupeGeneratedImageRecords(records);
}

export async function extractChatgptImagesFromConfiguredBrowser(
  options: ExtractChatgptImagesOptions,
): Promise<ChatgptImageExtractionResult> {
  const logger = options.log ?? ((_message: string) => {});
  const config = resolveBrowserConfig(options.config);
  const remoteChrome = config.remoteChrome;
  if (!remoteChrome) {
    throw new Error(
      "ChatGPT image extraction currently requires browser.remoteChrome or --remote-chrome so Oracle can attach to the logged-in browser.",
    );
  }

  const timeoutMs = options.timeoutMs ?? 30_000;
  const connection = await connectToRemoteChrome(
    remoteChrome.host,
    remoteChrome.port,
    logger,
    options.conversationUrl,
    { maxTabs: config.remoteChromeMaxTabs },
  );
  const client = connection.client;
  try {
    const { Runtime, Page } = client;
    await Promise.all([Runtime.enable(), Page.enable()]);
    await navigateToChatGPT(Page, Runtime, options.conversationUrl, logger);
    await waitForDocumentReady(Runtime, timeoutMs);
    const page = await snapshotChatgptPage(Runtime);
    const images = await waitForStableGeneratedImages(Runtime, timeoutMs);
    const artifacts =
      options.download === false
        ? []
        : await downloadGeneratedImages(Runtime, images, resolveOutputDir(options, page));
    return {
      page: {
        ...page,
        generatedImageNodeCount: images.reduce((sum, image) => sum + image.duplicateNodeCount, 0),
        uniqueGeneratedImageCount: images.length,
      },
      images,
      artifacts,
      outputDir: artifacts.length > 0 ? resolveOutputDir(options, page) : options.outputDir,
      warnings: [],
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

export async function downloadGeneratedImages(
  Runtime: ChromeClient["Runtime"],
  images: ChatgptGeneratedImage[],
  outputDir: string,
): Promise<ChatgptDownloadedImageArtifact[]> {
  await mkdir(outputDir, { recursive: true });
  const artifacts: ChatgptDownloadedImageArtifact[] = [];
  for (const image of images) {
    const fetched = await fetchImageInBrowser(Runtime, image.sourceUrl);
    const extension = extensionForMimeType(fetched.mimeType);
    const filename = `${String(image.variantIndex + 1).padStart(2, "0")}_${image.fileId}${extension}`;
    const downloadedPath = path.join(outputDir, filename);
    const bytes = Buffer.from(fetched.base64, "base64");
    await writeFile(downloadedPath, bytes);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const artifact: ChatgptDownloadedImageArtifact = {
      fileId: image.fileId,
      sourceUrl: image.sourceUrl,
      downloadedPath,
      mimeType: fetched.mimeType,
      width: fetched.width,
      height: fetched.height,
      byteSize: bytes.byteLength,
      sha256,
      variantIndex: image.variantIndex,
      downloadMethod: "browser-fetch",
    };
    await writeFile(`${downloadedPath}.json`, `${JSON.stringify(artifact, null, 2)}\n`);
    artifacts.push(artifact);
  }
  return artifacts;
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

async function waitForStableGeneratedImages(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
): Promise<ChatgptGeneratedImage[]> {
  const deadline = Date.now() + timeoutMs;
  let lastKey = "";
  let stableSince = 0;
  let lastImages: ChatgptGeneratedImage[] = [];
  while (Date.now() < deadline) {
    const images = await extractGeneratedImagesFromRuntime(Runtime);
    const key = images.map((image) => image.fileId).join("|");
    if (images.length > 0 && key === lastKey) {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince >= 750) {
        return images;
      }
    } else {
      stableSince = 0;
      lastKey = key;
    }
    lastImages = images;
    await delay(400);
  }
  return lastImages;
}

interface BrowserFetchedImage {
  base64: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

async function fetchImageInBrowser(
  Runtime: ChromeClient["Runtime"],
  sourceUrl: string,
): Promise<BrowserFetchedImage> {
  const { result, exceptionDetails } = await Runtime.evaluate({
    expression: buildFetchImageExpression(sourceUrl),
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(`Browser image fetch failed: ${exceptionDetails.text}`);
  }
  const value = result?.value as BrowserFetchedImage & { ok?: boolean; error?: string };
  if (!value?.ok) {
    throw new Error(value?.error ?? "Browser image fetch failed.");
  }
  return value;
}

function resolveOutputDir(
  options: ExtractChatgptImagesOptions,
  page: ChatgptPageSnapshot,
): string {
  if (options.outputDir) {
    return path.resolve(options.outputDir);
  }
  const conversationId = page.conversationId ?? "chatgpt-conversation";
  return path.resolve(process.cwd(), "oracle-chatgpt-images", conversationId);
}

function extensionForMimeType(mimeType?: string): string {
  const normalized = mimeType?.split(";")[0]?.trim().toLowerCase();
  switch (normalized) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".img";
  }
}

function normalizePageSnapshot(value: unknown): ChatgptPageSnapshot {
  if (!value || typeof value !== "object") {
    return {
      href: "",
      title: "",
      readyState: "",
      hasComposer: false,
      loginLikely: false,
      imageNodeCount: 0,
      generatedImageNodeCount: 0,
      uniqueGeneratedImageCount: 0,
    };
  }
  const record = value as Partial<ChatgptPageSnapshot>;
  return {
    href: typeof record.href === "string" ? record.href : "",
    title: typeof record.title === "string" ? record.title : "",
    readyState: typeof record.readyState === "string" ? record.readyState : "",
    hasComposer: Boolean(record.hasComposer),
    loginLikely: Boolean(record.loginLikely),
    imageNodeCount: numberOrZero(record.imageNodeCount),
    generatedImageNodeCount: numberOrZero(record.generatedImageNodeCount),
    uniqueGeneratedImageCount: numberOrZero(record.uniqueGeneratedImageCount),
    conversationId:
      typeof record.conversationId === "string" && record.conversationId
        ? record.conversationId
        : undefined,
    hasModelMenu: Boolean(record.hasModelMenu),
    modelMenuLabel: typeof record.modelMenuLabel === "string" ? record.modelMenuLabel : undefined,
    hasFileUploadControl: Boolean(record.hasFileUploadControl),
    hasPhotoUploadControl: Boolean(record.hasPhotoUploadControl),
    hasComposerPlusButton: Boolean(record.hasComposerPlusButton),
  };
}

function normalizeDomRecords(value: unknown): ChatgptImageDomRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ChatgptImageDomRecord[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Partial<ChatgptImageDomRecord>;
    if (typeof record.fileId !== "string" || typeof record.src !== "string") return [];
    return [
      {
        fileId: record.fileId,
        src: record.src,
        alt: typeof record.alt === "string" ? record.alt : undefined,
        turnId: typeof record.turnId === "string" ? record.turnId : null,
        messageId: typeof record.messageId === "string" ? record.messageId : null,
        turnIndex: typeof record.turnIndex === "number" ? record.turnIndex : null,
        renderedWidth: numberOrZero(record.renderedWidth),
        renderedHeight: numberOrZero(record.renderedHeight),
        area: numberOrZero(record.area),
        documentIndex: numberOrZero(record.documentIndex),
        isThumbnail: Boolean(record.isThumbnail),
        role: typeof record.role === "string" ? record.role : null,
        ancestorSummary: Array.isArray(record.ancestorSummary)
          ? record.ancestorSummary.filter((item): item is string => typeof item === "string")
          : [],
      },
    ];
  });
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buildPageSnapshotExpression(): string {
  return `(() => {
    const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
    const turnSelector = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
    const roleForImage = (img) => {
      const turn = img.closest(turnSelector);
      const attr = [
        turn?.getAttribute?.("data-message-author-role") || "",
        turn?.querySelector?.("[data-message-author-role]")?.getAttribute("data-message-author-role") || "",
        turn?.getAttribute?.("data-turn") || "",
        turn?.querySelector?.("[data-turn]")?.getAttribute("data-turn") || ""
      ].join(" ").toLowerCase();
      if (attr.includes("user")) return "user";
      if (attr.includes("assistant")) return "assistant";
      return "";
    };
    const generated = Array.from(document.images).filter((img) => {
      const src = img.currentSrc || img.src || "";
      try {
        const url = new URL(src, location.href);
        const id = url.searchParams.get("id") || "";
        return /^file_[A-Za-z0-9]+$/.test(id) && url.pathname.includes("/backend-api/estuary/") && roleForImage(img) !== "user";
      } catch {
        return false;
      }
    });
    const ids = new Set(generated.map((img) => {
      try { return new URL(img.currentSrc || img.src || "", location.href).searchParams.get("id"); }
      catch { return null; }
    }).filter(Boolean));
    const conversationMatch = location.pathname.match(/\\/c\\/([^/?#]+)/);
    const modelButton =
      document.querySelector('[data-testid="model-switcher-dropdown-button"]') ||
      document.querySelector('[aria-label*="model" i]') ||
      document.querySelector('button[id*="model" i]');
    const modelMenuLabel = modelButton
      ? ((modelButton.innerText || modelButton.textContent || modelButton.getAttribute?.("aria-label") || "").replace(/\\s+/g, " ").trim())
      : "";
    return {
      href: location.href,
      title: document.title || "",
      readyState: document.readyState || "",
      hasComposer: inputSelectors.some((selector) => document.querySelector(selector)),
      loginLikely: !/\\/auth\\//.test(location.pathname) && !/log in|sign in/i.test(document.body?.innerText || ""),
      imageNodeCount: document.images.length,
      generatedImageNodeCount: generated.length,
      uniqueGeneratedImageCount: ids.size,
      conversationId: conversationMatch ? conversationMatch[1] : undefined,
      hasModelMenu: Boolean(modelButton),
      modelMenuLabel,
      hasFileUploadControl: Boolean(document.querySelector('#upload-files,input[type="file"]:not([accept])')),
      hasPhotoUploadControl: Boolean(document.querySelector('#upload-photos,input[type="file"][accept*="image" i]')),
      hasComposerPlusButton: Boolean(document.querySelector('#composer-plus-btn,[data-testid="composer-plus-btn"]'))
    };
  })()`;
}

function buildImageExtractionExpression(): string {
  return `(() => {
    const TURN_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
    const records = [];
    const images = Array.from(document.images);
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
    const classesFor = (node) => {
      const items = [];
      let current = node;
      for (let i = 0; current && i < 5; i += 1) {
        const label = [
          current.tagName ? current.tagName.toLowerCase() : "",
          current.getAttribute ? current.getAttribute("role") || "" : "",
          current.className && typeof current.className === "string" ? current.className : ""
        ].filter(Boolean).join(":");
        if (label) items.push(label.slice(0, 240));
        current = current.parentElement;
      }
      return items;
    };
    const roleForTurn = (turn) => {
      const attr = [
        turn?.getAttribute?.("data-message-author-role") || "",
        turn?.querySelector?.("[data-message-author-role]")?.getAttribute("data-message-author-role") || "",
        turn?.getAttribute?.("data-turn") || "",
        turn?.querySelector?.("[data-turn]")?.getAttribute("data-turn") || ""
      ].join(" ").toLowerCase();
      if (attr.includes("user")) return "user";
      if (attr.includes("assistant")) return "assistant";
      return "";
    };
    images.forEach((img, documentIndex) => {
      const src = img.currentSrc || img.src || "";
      const fileId = fileIdFor(src);
      if (!fileId) return;
      const rect = img.getBoundingClientRect();
      const turn = img.closest(TURN_SELECTOR);
      if (roleForTurn(turn) === "user") return;
      const turnTestId = turn ? turn.getAttribute("data-testid") || "" : "";
      const turnIndexMatch = turnTestId.match(/conversation-turn-(\\d+)/);
      const ancestorText = classesFor(img).join(" ");
      const renderedWidth = Math.round(rect.width || 0);
      const renderedHeight = Math.round(rect.height || 0);
      records.push({
        fileId,
        src,
        alt: img.getAttribute("alt") || "",
        turnId: turnTestId || (turn ? turn.id || null : null),
        messageId: turn ? turn.getAttribute("data-message-id") || null : null,
        turnIndex: turnIndexMatch ? Number(turnIndexMatch[1]) : null,
        renderedWidth,
        renderedHeight,
        area: renderedWidth * renderedHeight,
        documentIndex,
        isThumbnail: renderedWidth <= 96 && renderedHeight <= 96 || /\\bw-14\\b|thumbnail|carousel/i.test(ancestorText),
        role: img.getAttribute("role") || null,
        ancestorSummary: classesFor(img)
      });
    });
    return records;
  })()`;
}

function buildFetchImageExpression(sourceUrl: string): string {
  return `(async () => {
    try {
      const response = await fetch(${JSON.stringify(sourceUrl)}, { credentials: "include" });
      if (!response.ok) {
        return { ok: false, error: "HTTP " + response.status + " while fetching image" };
      }
      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
      }
      const dimensions = await new Promise((resolve) => {
        const objectUrl = URL.createObjectURL(blob);
        const image = new Image();
        const cleanup = () => URL.revokeObjectURL(objectUrl);
        image.onload = () => {
          const result = { width: image.naturalWidth || undefined, height: image.naturalHeight || undefined };
          cleanup();
          resolve(result);
        };
        image.onerror = () => {
          cleanup();
          resolve({});
        };
        image.src = objectUrl;
      });
      return {
        ok: true,
        base64: btoa(binary),
        mimeType: blob.type || response.headers.get("content-type") || undefined,
        width: dimensions.width,
        height: dimensions.height
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })()`;
}
