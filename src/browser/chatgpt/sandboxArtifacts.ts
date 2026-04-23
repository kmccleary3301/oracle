import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { connectToRemoteChrome, closeRemoteChromeTarget } from "../chromeLifecycle.js";
import { resolveBrowserConfig } from "../config.js";
import { CONVERSATION_TURN_SELECTOR } from "../constants.js";
import { navigateToChatGPT } from "../actions/navigation.js";
import { delay } from "../utils.js";
import type { BrowserAutomationConfig, BrowserLogger, ChromeClient } from "../types.js";
import { snapshotChatgptPage } from "./imageArtifacts.js";
import type {
  ChatgptDownloadedSandboxArtifact,
  ChatgptPageSnapshot,
  ChatgptSandboxArtifactExtractionResult,
  ChatgptSandboxArtifactRef,
} from "./types.js";

export interface ExtractChatgptSandboxArtifactsOptions {
  conversationUrl: string;
  outputDir?: string;
  download?: boolean;
  config?: BrowserAutomationConfig;
  log?: BrowserLogger;
  timeoutMs?: number;
  keepTab?: boolean;
}

interface ResolvedArtifact extends ChatgptSandboxArtifactRef {
  sandboxPath?: string;
  fileId?: string;
  downloadUrl?: string;
}

export async function extractChatgptSandboxArtifactsFromConfiguredBrowser(
  options: ExtractChatgptSandboxArtifactsOptions,
): Promise<ChatgptSandboxArtifactExtractionResult> {
  const logger = options.log ?? ((_message: string) => {});
  const config = resolveBrowserConfig(options.config);
  const remoteChrome = config.remoteChrome;
  if (!remoteChrome) {
    throw new Error(
      "ChatGPT sandbox artifact extraction requires browser.remoteChrome or --remote-chrome.",
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
    const refs = await waitForSandboxArtifactRefs(Runtime, timeoutMs);
    const outputDir = resolveSandboxArtifactOutputDir(options.outputDir, page, options.conversationUrl);
    const downloadedArtifacts =
      options.download === false || refs.length === 0
        ? []
        : await downloadSandboxArtifacts(Runtime, refs, outputDir);
    return {
      page,
      sandboxArtifacts: refs,
      downloadedArtifacts,
      outputDir: downloadedArtifacts.length > 0 ? outputDir : options.outputDir,
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

export function buildSandboxArtifactIdentity(ref: ChatgptSandboxArtifactRef): string {
  return [
    ref.messageId ?? "",
    ref.turnId ?? "",
    String(ref.turnIndex),
    String(ref.documentIndex),
    ref.label.trim(),
  ].join("::");
}

export function dedupeSandboxArtifactRefs(
  refs: ChatgptSandboxArtifactRef[],
): ChatgptSandboxArtifactRef[] {
  const sorted = [...refs].sort((left, right) => {
    const turnDelta = left.turnIndex - right.turnIndex;
    if (turnDelta !== 0) return turnDelta;
    return left.documentIndex - right.documentIndex;
  });
  const deduped: ChatgptSandboxArtifactRef[] = [];
  for (const ref of sorted) {
    const duplicateIndex = deduped.findIndex((existing) => shouldMergeArtifactRefs(existing, ref));
    if (duplicateIndex === -1) {
      deduped.push(ref);
      continue;
    }
    deduped[duplicateIndex] = preferArtifactRef(deduped[duplicateIndex], ref);
  }
  return deduped;
}

export async function extractSandboxArtifactRefsFromRuntime(
  Runtime: ChromeClient["Runtime"],
): Promise<ChatgptSandboxArtifactRef[]> {
  const { result } = await Runtime.evaluate({
    expression: buildSandboxArtifactRefExpression(),
    returnByValue: true,
  });
  const value = result?.value;
  if (!Array.isArray(value)) {
    return [];
  }
  const refs = value.flatMap((entry): ChatgptSandboxArtifactRef[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Partial<ChatgptSandboxArtifactRef>;
    if (typeof item.label !== "string" || !item.label.trim()) return [];
    return [
      {
        label: item.label.trim(),
        turnIndex:
          typeof item.turnIndex === "number" && Number.isFinite(item.turnIndex)
            ? item.turnIndex
            : 0,
        turnId: typeof item.turnId === "string" ? item.turnId : null,
        messageId: typeof item.messageId === "string" ? item.messageId : null,
        documentIndex:
          typeof item.documentIndex === "number" && Number.isFinite(item.documentIndex)
            ? item.documentIndex
            : 0,
        },
      ];
  });
  return dedupeSandboxArtifactRefs(refs);
}

export async function waitForSandboxArtifactRefs(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
): Promise<ChatgptSandboxArtifactRef[]> {
  const deadline = Date.now() + timeoutMs;
  let refs = await extractSandboxArtifactRefsFromRuntime(Runtime);
  while (Date.now() < deadline) {
    if (refs.length > 0) return refs;
    await delay(400);
    refs = await extractSandboxArtifactRefsFromRuntime(Runtime);
  }
  return refs;
}

export async function waitForNewSandboxArtifactRefsFromRuntime(
  Runtime: ChromeClient["Runtime"],
  baselineRefs: ChatgptSandboxArtifactRef[],
  timeoutMs: number,
): Promise<ChatgptSandboxArtifactRef[]> {
  const baselineKeys = new Set(baselineRefs.map(buildSandboxArtifactIdentity));
  const deadline = Date.now() + timeoutMs;
  let refs = await extractSandboxArtifactRefsFromRuntime(Runtime);
  let next = refs.filter((ref) => !baselineKeys.has(buildSandboxArtifactIdentity(ref)));
  while (Date.now() < deadline) {
    if (next.length > 0) {
      return next;
    }
    await delay(400);
    refs = await extractSandboxArtifactRefsFromRuntime(Runtime);
    next = refs.filter((ref) => !baselineKeys.has(buildSandboxArtifactIdentity(ref)));
  }
  return next;
}

export async function downloadSandboxArtifacts(
  Runtime: ChromeClient["Runtime"],
  refs: ChatgptSandboxArtifactRef[],
  outputDir: string,
): Promise<ChatgptDownloadedSandboxArtifact[]> {
  await mkdir(outputDir, { recursive: true });
  const resolved = await resolveSandboxArtifactsFromRuntime(Runtime, refs);
  const artifacts: ChatgptDownloadedSandboxArtifact[] = [];
  const usedNames = new Set<string>();

  for (let index = 0; index < resolved.length; index += 1) {
    const artifact = resolved[index];
    if (!artifact.downloadUrl) {
      continue;
    }
    const fetched = await fetchBinaryInBrowser(Runtime, artifact.downloadUrl);
    const fileName = resolveArtifactFileName(artifact, index, fetched.mimeType, usedNames);
    const downloadedPath = path.join(outputDir, fileName);
    const bytes = Buffer.from(fetched.base64, "base64");
    await writeFile(downloadedPath, bytes);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const downloaded: ChatgptDownloadedSandboxArtifact = {
      label: artifact.label,
      turnIndex: artifact.turnIndex,
      turnId: artifact.turnId,
      messageId: artifact.messageId,
      documentIndex: artifact.documentIndex,
      sandboxPath: artifact.sandboxPath,
      fileId: artifact.fileId,
      fileName,
      downloadedPath,
      mimeType: fetched.mimeType,
      byteSize: bytes.byteLength,
      sha256,
      downloadMethod: "browser-fetch",
    };
    await writeFile(`${downloadedPath}.json`, `${JSON.stringify(downloaded, null, 2)}\n`);
    artifacts.push(downloaded);
  }

  return artifacts;
}

export function resolveSandboxArtifactOutputDir(
  explicitOutputDir: string | undefined,
  pageOrConversation?: ChatgptPageSnapshot | string,
  fallbackConversationUrl?: string,
): string {
  if (explicitOutputDir) {
    return path.resolve(explicitOutputDir);
  }
  const href =
    typeof pageOrConversation === "string"
      ? pageOrConversation
      : pageOrConversation?.href ?? fallbackConversationUrl ?? "";
  const conversationId =
    extractConversationIdFromUrl(href) ??
    (typeof pageOrConversation === "object" ? pageOrConversation?.conversationId : undefined) ??
    "chatgpt-conversation";
  return path.resolve(process.cwd(), "oracle-chatgpt-artifacts", conversationId);
}

async function resolveSandboxArtifactsFromRuntime(
  Runtime: ChromeClient["Runtime"],
  refs: ChatgptSandboxArtifactRef[],
): Promise<ResolvedArtifact[]> {
  if (refs.length === 0) {
    return [];
  }
  const { result, exceptionDetails } = await Runtime.evaluate({
    expression: buildResolveSandboxArtifactsExpression(refs),
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.text ?? "sandbox artifact resolution failed");
  }
  const value = result?.value;
  if (!Array.isArray(value)) {
    return [];
  }
  const resolved = value.flatMap((entry): ResolvedArtifact[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Partial<ResolvedArtifact>;
    if (typeof item.label !== "string" || !item.label.trim()) return [];
    return [
      {
        label: item.label.trim(),
        turnIndex:
          typeof item.turnIndex === "number" && Number.isFinite(item.turnIndex)
            ? item.turnIndex
            : 0,
        turnId: typeof item.turnId === "string" ? item.turnId : null,
        messageId: typeof item.messageId === "string" ? item.messageId : null,
        documentIndex:
          typeof item.documentIndex === "number" && Number.isFinite(item.documentIndex)
            ? item.documentIndex
            : 0,
        sandboxPath: typeof item.sandboxPath === "string" ? item.sandboxPath : undefined,
        fileId: typeof item.fileId === "string" ? item.fileId : undefined,
        downloadUrl: typeof item.downloadUrl === "string" ? item.downloadUrl : undefined,
        },
      ];
  });
  return dedupeResolvedArtifacts(resolved);
}

function resolveArtifactFileName(
  artifact: ResolvedArtifact,
  index: number,
  mimeType: string | undefined,
  usedNames: Set<string>,
): string {
  const sandboxBase = lastNonEmptyPathSegment(artifact.sandboxPath);
  const messageTag = artifact.messageId ? sanitizeSegment(artifact.messageId.slice(0, 8)) : "unknown";
  const labelBase = sanitizeSegment(sandboxBase ?? artifact.label) || `artifact-${artifact.documentIndex}`;
  const labelWithExt = ensureExtension(labelBase, mimeType);
  const prefix = `${String(index + 1).padStart(2, "0")}_turn-${String(artifact.turnIndex + 1).padStart(2, "0")}_msg-${messageTag}`;
  let candidate = `${prefix}_${labelWithExt}`;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${prefix}_${suffix}_${labelWithExt}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function lastNonEmptyPathSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const segments = value.split("/");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment) {
      return segment;
    }
  }
  return undefined;
}

function shouldMergeArtifactRefs(
  existing: ChatgptSandboxArtifactRef,
  next: ChatgptSandboxArtifactRef,
): boolean {
  if (existing.label !== next.label) {
    return false;
  }
  const turnDistance = Math.abs(existing.turnIndex - next.turnIndex);
  if (turnDistance > 1) {
    return false;
  }
  if (existing.messageId && next.messageId) {
    return existing.messageId === next.messageId;
  }
  if (existing.messageId || next.messageId) {
    return true;
  }
  if (existing.turnId && next.turnId) {
    return existing.turnId === next.turnId;
  }
  return turnDistance <= 1;
}

function preferArtifactRef(
  existing: ChatgptSandboxArtifactRef,
  next: ChatgptSandboxArtifactRef,
): ChatgptSandboxArtifactRef {
  if (!existing.messageId && next.messageId) {
    return next;
  }
  if (existing.messageId && !next.messageId) {
    return existing;
  }
  if (existing.turnId && !next.turnId) {
    return existing;
  }
  if (!existing.turnId && next.turnId) {
    return next;
  }
  return next.documentIndex >= existing.documentIndex ? next : existing;
}

function dedupeResolvedArtifacts(artifacts: ResolvedArtifact[]): ResolvedArtifact[] {
  const seen = new Map<string, ResolvedArtifact>();
  for (const artifact of artifacts) {
    const key =
      artifact.fileId ??
      artifact.sandboxPath ??
      (artifact.downloadUrl ? `download:${artifact.downloadUrl}` : buildSandboxArtifactIdentity(artifact));
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, artifact);
      continue;
    }
    seen.set(key, preferResolvedArtifact(existing, artifact));
  }
  return Array.from(seen.values()).sort((left, right) => {
    const turnDelta = left.turnIndex - right.turnIndex;
    if (turnDelta !== 0) return turnDelta;
    return left.documentIndex - right.documentIndex;
  });
}

function preferResolvedArtifact(existing: ResolvedArtifact, next: ResolvedArtifact): ResolvedArtifact {
  if (!existing.messageId && next.messageId) {
    return next;
  }
  if (existing.messageId && !next.messageId) {
    return existing;
  }
  if (!existing.sandboxPath && next.sandboxPath) {
    return next;
  }
  if (existing.sandboxPath && !next.sandboxPath) {
    return existing;
  }
  return next.documentIndex >= existing.documentIndex ? next : existing;
}

function ensureExtension(name: string, mimeType?: string): string {
  const ext = extensionForMimeType(mimeType);
  if (!ext) return name;
  if (path.extname(name).toLowerCase() === ext.toLowerCase()) {
    return name;
  }
  return `${name}${ext}`;
}

function extensionForMimeType(mimeType?: string): string {
  const normalized = mimeType?.split(";")[0]?.trim().toLowerCase();
  switch (normalized) {
    case "application/zip":
      return ".zip";
    case "text/markdown":
      return ".md";
    case "application/json":
    case "text/json":
      return ".json";
    case "text/plain":
      return ".txt";
    case "application/pdf":
      return ".pdf";
    case "text/csv":
      return ".csv";
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    default:
      return "";
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
}

async function fetchBinaryInBrowser(
  Runtime: ChromeClient["Runtime"],
  sourceUrl: string,
): Promise<{ base64: string; mimeType?: string }> {
  const { result, exceptionDetails } = await Runtime.evaluate({
    expression: `(${async (url: string) => {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) {
        return { ok: false, error: `Artifact download failed: ${response.status}` };
      }
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const chunkSize = 0x8000;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
      }
      return {
        ok: true,
        base64: btoa(binary),
        mimeType: response.headers.get("content-type") || undefined,
      };
    }})(${JSON.stringify(sourceUrl)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.text ?? "artifact fetch failed");
  }
  const value = result?.value as
    | { ok?: boolean; error?: string; base64?: string; mimeType?: string }
    | undefined;
  if (!value?.ok || typeof value.base64 !== "string") {
    throw new Error(value?.error ?? "artifact fetch failed");
  }
  return {
    base64: value.base64,
    mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
  };
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

function buildSandboxArtifactRefExpression(): string {
  return `(() => {
    const TURN_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const roleFor = (turn) => {
      const attr = [
        turn.getAttribute("data-message-author-role"),
        turn.getAttribute("data-turn"),
        turn.querySelector("[data-message-author-role]")?.getAttribute("data-message-author-role"),
        turn.querySelector("[data-turn]")?.getAttribute("data-turn"),
      ].filter(Boolean).join(" ").toLowerCase();
      if (attr.includes("assistant")) return "assistant";
      if (attr.includes("user")) return "user";
      return "unknown";
    };
    const refs = [];
    Array.from(document.querySelectorAll(TURN_SELECTOR)).forEach((turn, turnIndex) => {
      if (roleFor(turn) !== "assistant") return;
      const markdown = turn.querySelector(".markdown");
      if (!markdown) return;
      Array.from(markdown.querySelectorAll("button.behavior-btn.entity-underline")).forEach((button) => {
        const label = normalize(button.innerText || button.textContent);
        if (!label) return;
        refs.push({
          label,
          turnIndex,
          turnId: turn.getAttribute("data-testid") || turn.id || null,
          messageId: turn.getAttribute("data-message-id") || null,
          documentIndex: refs.length,
        });
      });
    });
    return refs;
  })()`;
}

function buildResolveSandboxArtifactsExpression(refs: ChatgptSandboxArtifactRef[]): string {
  return `(() => {
    const TURN_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
    const targets = ${JSON.stringify(refs)};
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const roleFor = (turn) => {
      const attr = [
        turn.getAttribute("data-message-author-role"),
        turn.getAttribute("data-turn"),
        turn.querySelector("[data-message-author-role]")?.getAttribute("data-message-author-role"),
        turn.querySelector("[data-turn]")?.getAttribute("data-turn"),
      ].filter(Boolean).join(" ").toLowerCase();
      if (attr.includes("assistant")) return "assistant";
      if (attr.includes("user")) return "user";
      return "unknown";
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    return (async () => {
      const allRefs = [];
      Array.from(document.querySelectorAll(TURN_SELECTOR)).forEach((turn, turnIndex) => {
        if (roleFor(turn) !== "assistant") return;
        const markdown = turn.querySelector(".markdown");
        if (!markdown) return;
        Array.from(markdown.querySelectorAll("button.behavior-btn.entity-underline")).forEach((button) => {
          if (!(button instanceof HTMLButtonElement)) return;
          const label = normalize(button.innerText || button.textContent);
          if (!label) return;
          allRefs.push({
            label,
            turnIndex,
            turnId: turn.getAttribute("data-testid") || turn.id || null,
            messageId: turn.getAttribute("data-message-id") || null,
            documentIndex: allRefs.length,
            button,
          });
        });
      });

      const desired = targets
        .map((target) =>
          allRefs.find(
            (entry) =>
              entry.documentIndex === target.documentIndex &&
              entry.label === target.label &&
              entry.messageId === target.messageId,
          ) ||
          allRefs.find(
            (entry) => entry.label === target.label && entry.turnIndex === target.turnIndex,
          ) ||
          allRefs.find((entry) => entry.label === target.label) ||
          null,
        )
        .filter(Boolean);

      const originalFetch = window.fetch.bind(window);
      const originalAnchorClick = HTMLAnchorElement.prototype.click;
      const originalOpen = typeof window.open === "function" ? window.open.bind(window) : null;
      const logs = [];
      const push = (entry) => logs.push({ t: Date.now(), ...entry });

      window.fetch = async (...args) => {
        const input = args[0];
        const init = args[1] || {};
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input && typeof input === "object" && "url" in input
                ? input.url
                : "";
        const response = await originalFetch(...args);
        if (String(url).includes("/interpreter/download")) {
          const clone = response.clone();
          let body = null;
          try {
            body = await clone.json();
          } catch {
            try {
              body = await clone.text();
            } catch {
              body = null;
            }
          }
          push({
            type: "interpreter-download",
            requestUrl: url,
            method: init.method || "GET",
            status: response.status,
            response: body,
          });
        }
        return response;
      };

      HTMLAnchorElement.prototype.click = function patchedAnchorClick() {
        push({
          type: "anchor-click",
          href: this.href,
          download: this.download || null,
        });
      };

      if (originalOpen) {
        window.open = (...args) => {
          push({ type: "open", url: args[0] ? String(args[0]) : "" });
          return null;
        };
      }

      try {
        const resolved = [];
        for (const entry of desired) {
          const startIndex = logs.length;
          entry.button.scrollIntoView({ block: "center", inline: "center" });
          entry.button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
          entry.button.click();
          const deadline = Date.now() + 4000;
          while (Date.now() < deadline) {
            const recent = logs.slice(startIndex);
            if (
              recent.some(
                (log) =>
                  log.type === "interpreter-download" ||
                  log.type === "anchor-click" ||
                  log.type === "open",
              )
            ) {
              break;
            }
            await sleep(100);
          }
          const recent = logs.slice(startIndex);
          const interpreter = recent.find((log) => log.type === "interpreter-download");
          const anchor = recent.find((log) => log.type === "anchor-click");
          let requestUrl = null;
          if (interpreter && typeof interpreter.requestUrl === "string") {
            try {
              requestUrl = new URL(interpreter.requestUrl, location.href);
            } catch {
              requestUrl = null;
            }
          }
          const response =
            interpreter && interpreter.response && typeof interpreter.response === "object"
              ? interpreter.response
              : {};
          const downloadUrl =
            typeof response.download_url === "string" && response.download_url
              ? response.download_url
              : anchor && typeof anchor.href === "string" && anchor.href
                ? anchor.href
                : undefined;
          const sandboxPath = requestUrl ? requestUrl.searchParams.get("sandbox_path") || undefined : undefined;
          let fileId;
          if (downloadUrl) {
            try {
              const parsed = new URL(downloadUrl, location.href);
              const id = (parsed.searchParams.get("id") || "").trim();
              fileId = /^file_[A-Za-z0-9]+$/.test(id) ? id : undefined;
            } catch {
              fileId = undefined;
            }
          }
          resolved.push({
            label: entry.label,
            turnIndex: entry.turnIndex,
            turnId: entry.turnId,
            messageId: (requestUrl && requestUrl.searchParams.get("message_id")) || entry.messageId || null,
            documentIndex: entry.documentIndex,
            sandboxPath,
            fileId,
            downloadUrl,
          });
        }
        return resolved;
      } finally {
        window.fetch = originalFetch;
        HTMLAnchorElement.prototype.click = originalAnchorClick;
        if (originalOpen) {
          window.open = originalOpen;
        }
      }
    })();
  })()`;
}

function extractConversationIdFromUrl(rawUrl: string): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    const match = parsed.pathname.match(/\/c\/([^/?#]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
