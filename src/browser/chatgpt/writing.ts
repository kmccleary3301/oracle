import { createHash } from "node:crypto";
import type { BrowserLogger } from "../types.js";
import { extractChatgptResponseOutput } from "../actions/responseOutput.js";
import {
  ApprovalGrantAuthority,
  bindApprovalChallenge,
  createApprovalChallenge,
  type ApprovalChallenge,
} from "../approvalToken.js";
import type {
  ChatgptWritingMessage,
  ChatgptWritingSnapshot,
  CodeBlockCopyInput,
  CodeBlockGetInput,
  CodeBlockListInput,
  CodeBlockSaveInput,
  WritingActionResult,
  WritingArtifact,
  WritingBlock,
  WritingCapabilityEvidence,
  WritingEditInput,
  WritingExportInput,
  WritingExtractionInput,
  WritingExtractionResult,
  WritingGetInput,
  WritingOperation,
  WritingPlan,
  WritingPreviewInput,
  WritingRun,
  WritingRunInput,
  WritingStatus,
  WritingStopInput,
  WritingTargetInput,
  WritingBrowserDriver,
  WritingCodeBlock,
  WritingProseBlock,
  WritingTableBlock,
  WritingRuntimeOptions,
} from "./writingTypes.js";
import type { BrowserResponseProvenance } from "../types.js";

const UNKNOWN_ID = "unknown";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .trim();
}

function htmlAttribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return tag.match(new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] ?? null;
}

function conversationIdFromUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.pathname.match(/\/c\/([^/]+)/i)?.[1] ?? null;
  } catch {
    return value.match(/\/c\/([^/]+)/i)?.[1] ?? null;
  }
}

function stripProse(value: string): string {
  return decodeEntities(
    value
      .replace(/<(script|style|form|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<pre\b[^>]*>[\s\S]*?<\/pre\s*>/gi, "")
      .replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, ""),
  );
}

function languageFromCodeTag(tag: string): string | null {
  const language = htmlAttribute(tag, "class")?.match(/(?:language|lang)-([\w+-]+)/i)?.[1];
  return language?.toLowerCase() ?? null;
}

function parseCode(raw: string): { language: string | null; code: string } {
  const match = raw.match(/<pre\b[^>]*>\s*<code\b([^>]*)>([\s\S]*?)<\/code\s*>\s*<\/pre\s*>/i);
  if (!match) return { language: null, code: decodeEntities(raw) };
  return { language: languageFromCodeTag(match[1] ?? ""), code: decodeEntities(match[2] ?? "") };
}

function parseTable(raw: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  for (const row of raw.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
    const cells = Array.from((row[1] ?? "").matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi)).map(
      (cell) => decodeEntities(cell[1] ?? ""),
    );
    if (cells.length) rows.push(cells);
  }
  return { headers: rows[0] ?? [], rows: rows.slice(1) };
}

/** Identity is content-independent except for the observed conversation revision. */
export function computeWritingBlockId(input: {
  conversationId: string;
  turnId: string;
  messageId: string;
  index: number;
  language?: string | null;
  revisionHash: string;
}): string {
  const material = JSON.stringify({
    version: 1,
    conversationId: input.conversationId,
    turnId: input.turnId,
    messageId: input.messageId,
    index: input.index,
    language: input.language ?? null,
    revisionHash: input.revisionHash,
  });
  return `writing-${sha256(material)}`;
}

function provenanceFor(
  input: WritingExtractionInput,
  conversationId: string,
): BrowserResponseProvenance {
  return {
    source: "chatgpt-dom",
    capturedAt: new Date().toISOString(),
    ...(input.conversationUrl ? { conversationUrl: input.conversationUrl } : {}),
    ...(conversationId ? { conversationId } : {}),
    turnId: input.turnId ?? null,
    messageId: input.messageId ?? null,
    ...(input.turnIndex === undefined ? {} : { turnIndex: input.turnIndex }),
  };
}

function makeIdentity(
  input: WritingExtractionInput,
  index: number,
  language: string | null,
  revisionHash: string,
) {
  const conversationId =
    asString(input.conversationId) ?? conversationIdFromUrl(input.conversationUrl) ?? UNKNOWN_ID;
  const turnId = asString(input.turnId) ?? UNKNOWN_ID;
  const messageId = asString(input.messageId) ?? UNKNOWN_ID;
  return {
    blockId: computeWritingBlockId({
      conversationId,
      turnId,
      messageId,
      index,
      language,
      revisionHash,
    }),
    conversationId,
    turnId,
    messageId,
    index,
    language,
    revisionHash,
  };
}

/** Extracts only prose, fenced code, and tables from the already sanitised response output. */
export function extractWritingBlocks(input: WritingExtractionInput): WritingExtractionResult {
  const responseOutput = extractChatgptResponseOutput(input);
  const html = responseOutput.sanitizedHtml;
  const conversationId =
    asString(input.conversationId) ?? conversationIdFromUrl(input.conversationUrl) ?? UNKNOWN_ID;
  const revisionHash = asString(input.revisionHash) ?? sha256(html);
  const provenance = provenanceFor(input, conversationId);
  const ranges: Array<{ start: number; end: number; kind: "code" | "table"; raw: string }> = [];
  for (const match of html.matchAll(
    /<pre\b[^>]*>\s*<code\b[^>]*>[\s\S]*?<\/code\s*>\s*<\/pre\s*>/gi,
  )) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length, kind: "code", raw: match[0] });
  }
  for (const match of html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length, kind: "table", raw: match[0] });
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);

  const blocks: WritingBlock[] = [];
  let cursor = 0;
  const addProse = (raw: string): void => {
    const text = stripProse(raw);
    if (!text) return;
    const index = blocks.length;
    const identity = makeIdentity(input, index, null, revisionHash);
    const block: WritingProseBlock = {
      ...identity,
      kind: "prose",
      text,
      html: raw,
      provenance: { ...provenance },
    };
    blocks.push(block);
  };
  for (const range of ranges) {
    if (range.start < cursor) continue;
    addProse(html.slice(cursor, range.start));
    const index = blocks.length;
    if (range.kind === "code") {
      const parsed = parseCode(range.raw);
      const identity = makeIdentity(input, index, parsed.language, revisionHash);
      const block: WritingCodeBlock = {
        ...identity,
        kind: "code",
        code: parsed.code,
        provenance: { ...provenance },
      };
      blocks.push(block);
    } else {
      const parsed = parseTable(range.raw);
      const identity = makeIdentity(input, index, null, revisionHash);
      const block: WritingTableBlock = {
        ...identity,
        kind: "table",
        ...parsed,
        provenance: { ...provenance },
      };
      blocks.push(block);
    }
    cursor = range.end;
  }
  addProse(html.slice(cursor));
  if (!ranges.length && !blocks.length && html) addProse(html);

  return { blocks, responseOutput, provenance, revisionHash };
}

export function createWritingApprovalChallenge(
  operation: WritingOperation,
  blockId: string,
  revisionHash: string,
  expiry = Date.now() + 5 * 60 * 1000,
  payload: Record<string, unknown> = {},
): ApprovalChallenge {
  return createApprovalChallenge({
    operation,
    target: blockId,
    revision: revisionHash,
    payload: { blockId, ...payload },
    expiry,
  });
}

function writingApprovalPayload(
  input: WritingTargetInput,
  consequential: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    conversationId: input.conversationId,
    turnId: input.turnId,
    messageId: input.messageId,
    blockId: input.blockId,
    ...consequential,
  };
}

function capability(overrides: Partial<WritingCapabilityEvidence> = {}): WritingCapabilityEvidence {
  return {
    controls: {
      writing: false,
      edit: false,
      preview: false,
      run: false,
      stop: false,
      export: false,
      codeBlock: false,
      ...overrides.controls,
    },
    supported: overrides.supported ?? false,
    ...(overrides.reason ? { reason: overrides.reason } : {}),
  };
}

function capabilityFromSnapshot(snapshot: ChatgptWritingSnapshot): WritingCapabilityEvidence {
  return snapshot.capability ?? capability();
}

function resultBase(
  operation: WritingOperation,
  snapshot: ChatgptWritingSnapshot,
  dryRun = false,
): WritingActionResult {
  return {
    status: snapshot.status,
    operation,
    conversationId: snapshot.conversationId,
    turnId: snapshot.turnId,
    messageId: snapshot.messageId,
    revisionHash: snapshot.revisionHash,
    blocks: snapshot.blocks,
    ...(snapshot.provenance ? { provenance: snapshot.provenance } : {}),
    dryRun,
    approvalChallenge: null,
    capability: capabilityFromSnapshot(snapshot),
    ...(snapshot.reason ? { reason: snapshot.reason } : {}),
  };
}

function identityMatches(block: WritingBlock, input: WritingTargetInput): boolean {
  return (
    block.conversationId === input.conversationId &&
    block.turnId === input.turnId &&
    block.messageId === input.messageId &&
    block.blockId === input.blockId &&
    block.revisionHash === input.revisionHash
  );
}

function sameBlockContent(a: WritingBlock, b: WritingBlock): boolean {
  if (a.kind !== b.kind || a.blockId !== b.blockId) return false;
  if (a.kind === "code" && b.kind === "code") return a.code === b.code && a.language === b.language;
  if (a.kind === "prose" && b.kind === "prose") return a.text === b.text;
  if (a.kind === "table" && b.kind === "table")
    return JSON.stringify([a.headers, a.rows]) === JSON.stringify([b.headers, b.rows]);
  return false;
}

function safeStatus(_error: unknown): WritingActionResult {
  return {
    status: "disconnected",
    operation: "writing.get",
    conversationId: null,
    turnId: null,
    messageId: null,
    revisionHash: null,
    dryRun: false,
    approvalChallenge: null,
    capability: capability({ reason: "disconnected" }),
    reason: "disconnected",
  };
}

function targetResult(
  operation: WritingOperation,
  snapshot: ChatgptWritingSnapshot,
  input: WritingTargetInput,
): WritingActionResult | null {
  if (snapshot.conversationId !== input.conversationId) {
    return {
      ...resultBase(operation, snapshot),
      status: "conflict",
      blockId: input.blockId,
      reason: "conversation-mismatch",
    };
  }
  if (snapshot.revisionHash !== input.revisionHash) {
    return {
      ...resultBase(operation, snapshot),
      status: "conflict",
      blockId: input.blockId,
      reason: "revision-mismatch",
    };
  }
  const block = snapshot.blocks.find((candidate) => candidate.blockId === input.blockId);
  if (!block || !identityMatches(block, input)) {
    return {
      ...resultBase(operation, snapshot),
      status: "conflict",
      blockId: input.blockId,
      reason: "block-mismatch",
    };
  }
  return null;
}

function planFor(operation: WritingOperation, block: WritingBlock, summary?: string): WritingPlan {
  return {
    operation,
    target: {
      blockId: block.blockId,
      conversationId: block.conversationId,
      turnId: block.turnId,
      messageId: block.messageId,
      index: block.index,
      language: block.language,
      revisionHash: block.revisionHash,
    },
    revisionHash: block.revisionHash,
    consequential:
      operation === "writing.run" ||
      operation === "writing.export" ||
      operation === "codeBlock.save",
    externalWrite: operation === "writing.export" || operation === "codeBlock.save",
    unknown: false,
    ...(summary ? { summary } : {}),
  };
}

function withTarget(result: WritingActionResult, block: WritingBlock): WritingActionResult {
  return { ...result, blockId: block.blockId, block, provenance: block.provenance };
}

function normalizeBytes(value: WritingArtifact | Uint8Array | string): {
  bytes: Uint8Array;
  claimed?: WritingArtifact;
} {
  if (value && typeof value === "object" && "bytes" in value && !(value instanceof Uint8Array)) {
    const artifact = value as WritingArtifact;
    return { bytes: normalizeBytes(artifact.bytes).bytes, claimed: artifact };
  }
  if (typeof value === "string") return { bytes: new TextEncoder().encode(value) };
  return { bytes: value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer) };
}

function defaultMime(block: WritingBlock): string {
  if (block.kind === "table") return "text/csv";
  if (block.kind === "prose") return "text/plain";
  switch (block.language?.toLowerCase()) {
    case "json":
      return "application/json";
    case "js":
    case "javascript":
      return "text/javascript";
    case "ts":
    case "typescript":
      return "text/typescript";
    case "py":
    case "python":
      return "text/x-python";
    case "html":
      return "text/html";
    case "css":
      return "text/css";
    default:
      return "text/plain";
  }
}

function artifactFor(
  value: WritingArtifact | Uint8Array | string,
  block: WritingBlock,
  input: WritingExportInput,
): WritingArtifact | null {
  const normalized = normalizeBytes(value);
  const bytes = normalized.bytes;
  const claimed = normalized.claimed;
  const mimeType = claimed?.mimeType ?? input.mimeType ?? defaultMime(block);
  if (
    (claimed && claimed.conversationId !== block.conversationId) ||
    (claimed && claimed.turnId !== block.turnId) ||
    (claimed && claimed.messageId !== block.messageId) ||
    (claimed && claimed.blockId !== block.blockId)
  )
    return null;
  if (claimed && claimed.byteSize !== bytes.byteLength) return null;
  const digest = sha256(bytes);
  if (claimed && claimed.sha256 !== digest) return null;
  if (input.mimeType && mimeType !== input.mimeType) return null;
  return {
    ...(claimed ?? {}),
    path: claimed?.path ?? input.outputPath,
    mimeType,
    byteSize: bytes.byteLength,
    sha256: digest,
    bytes,
    conversationId: block.conversationId,
    turnId: block.turnId,
    messageId: block.messageId,
    blockId: block.blockId,
    provenance: block.provenance,
  };
}

export class ChatgptWritingService {
  private readonly activeRuns = new Map<string, WritingRun>();
  constructor(
    private readonly driver: WritingBrowserDriver,
    private readonly logger: BrowserLogger = (() => undefined) as BrowserLogger,
    private readonly approvalAuthority?: ApprovalGrantAuthority,
    private readonly principal?: string,
    private readonly session?: string,
  ) {}

  async get(input: WritingGetInput): Promise<WritingActionResult> {
    try {
      const snapshot = await this.driver.get(input);
      return resultBase("writing.get", snapshot);
    } catch (error) {
      this.logger(
        `ChatGPT writing get unavailable: ${error instanceof Error ? "driver-error" : "unknown-error"}`,
      );
      return safeStatus(error);
    }
  }

  private async readTarget(
    operation: WritingOperation,
    input: WritingTargetInput,
  ): Promise<{ snapshot: ChatgptWritingSnapshot; block: WritingBlock } | WritingActionResult> {
    try {
      const snapshot = await this.driver.get(input);
      const conflict = targetResult(operation, snapshot, input);
      if (conflict) return conflict;
      const block = snapshot.blocks.find(
        (candidate) => candidate.blockId === input.blockId,
      ) as WritingBlock;
      return { snapshot, block };
    } catch (error) {
      this.logger(
        `ChatGPT writing ${operation} unavailable: ${error instanceof Error ? "driver-error" : "unknown-error"}`,
      );
      return safeStatus(error);
    }
  }

  async edit(input: WritingEditInput): Promise<WritingActionResult> {
    const read = await this.readTarget("writing.edit", input);
    if (!("snapshot" in read)) return read;
    const { snapshot, block } = read;
    const result = withTarget(resultBase("writing.edit", snapshot, Boolean(input.dryRun)), block);
    const challenge = bindApprovalChallenge(
      createWritingApprovalChallenge(
        "writing.edit",
        block.blockId,
        block.revisionHash,
        undefined,
        writingApprovalPayload(input, { content: input.content }),
      ),
      input.approvalChallenge,
    );
    if (input.dryRun) {
      const plan = planFor("writing.edit", block, "Edit only the addressed writing block.");
      return { ...result, status: "preview", plan, approvalChallenge: challenge };
    }
    if (!this.approvalAuthority)
      return {
        ...result,
        status: "requires_action",
        approvalChallenge: challenge,
        reason: "approval-authority-unavailable",
      };
    const consumedEdit = this.approvalAuthority.consumeGrant(input.approvalGrant, challenge, {
      principal: this.principal,
      session: this.session,
    });
    if (consumedEdit.state !== "consumed")
      return {
        ...result,
        status: "requires_action",
        approvalChallenge: challenge,
        reason: consumedEdit.reason,
      };
    if (!this.driver.edit)
      return {
        ...result,
        status: "unsupported",
        capability: { ...capabilityFromSnapshot(snapshot), reason: "unsupported-action" },
      };
    const before = snapshot.blocks;
    const edited = await this.driver.edit(input);
    const after = "blocks" in edited ? edited : await this.driver.get(input);
    const target = after.blocks.find((candidate) => candidate.blockId === block.blockId);
    const unchangedOthers = before.every(
      (candidate) =>
        candidate.blockId === block.blockId ||
        after.blocks.some((next) => sameBlockContent(candidate, next)),
    );
    if (!target || !unchangedOthers)
      return { ...result, status: "conflict", reason: "block-mismatch" };
    return {
      ...resultBase("writing.edit", after),
      status: "ok",
      blockId: target.blockId,
      block: target,
      provenance: target.provenance,
    };
  }

  async preview(input: WritingPreviewInput): Promise<WritingActionResult> {
    const read = await this.readTarget("writing.preview", input);
    if (!("snapshot" in read)) return read;
    const { snapshot, block } = read;
    const before = snapshot.blocks;
    try {
      const previewed = this.driver.preview
        ? await this.driver.preview(input)
        : this.previewBlock(block, input.content);
      const resultBlock =
        "blocks" in previewed
          ? previewed.blocks.find((candidate) => candidate.blockId === block.blockId)
          : previewed;
      const after = await this.driver.get(input);
      if (
        !before.every((candidate) => after.blocks.some((next) => sameBlockContent(candidate, next)))
      ) {
        return {
          ...resultBase("writing.preview", after),
          status: "conflict",
          blockId: block.blockId,
          reason: "block-mismatch",
        };
      }
      return withTarget(
        { ...resultBase("writing.preview", snapshot), status: "preview", dryRun: true },
        resultBlock && identityMatches(resultBlock, input) ? resultBlock : block,
      );
    } catch (error) {
      this.logger(
        `ChatGPT writing preview unavailable: ${error instanceof Error ? "driver-error" : "unknown-error"}`,
      );
      return safeStatus(error);
    }
  }

  private previewBlock(block: WritingBlock, content: string | undefined): WritingBlock {
    if (content === undefined) return block;
    if (block.kind === "code") return { ...block, code: content };
    if (block.kind === "prose") return { ...block, text: content };
    return block;
  }

  async run(input: WritingRunInput): Promise<WritingActionResult> {
    const read = await this.readTarget("writing.run", input);
    if (!("snapshot" in read)) return read;
    const { snapshot, block } = read;
    const result = withTarget(resultBase("writing.run", snapshot, Boolean(input.dryRun)), block);
    const challenge = bindApprovalChallenge(
      createWritingApprovalChallenge(
        "writing.run",
        block.blockId,
        block.revisionHash,
        undefined,
        writingApprovalPayload(input),
      ),
      input.approvalChallenge,
    );
    if (input.dryRun)
      return {
        ...result,
        status: "requires_action",
        plan: planFor(
          "writing.run",
          block,
          "Running a writing block executes code or an external action.",
        ),
        approvalChallenge: challenge,
      };
    if (!this.approvalAuthority)
      return {
        ...result,
        status: "requires_action",
        approvalChallenge: challenge,
        reason: "approval-authority-unavailable",
      };
    const consumedRun = this.approvalAuthority.consumeGrant(input.approvalGrant, challenge, {
      principal: this.principal,
      session: this.session,
    });
    if (consumedRun.state !== "consumed")
      return {
        ...result,
        status: "requires_action",
        approvalChallenge: challenge,
        reason: consumedRun.reason,
      };
    if (!this.driver.run) return { ...result, status: "unsupported", reason: "unsupported-action" };
    try {
      const runResult = await this.driver.run(input);
      const run = "runId" in runResult ? runResult : runResult.activeRun;
      if (!run) return { ...result, status: "requires_action", reason: "run-not-started" };
      this.activeRuns.set(run.runId, run);
      return {
        ...result,
        status: run.status === "requires_action" ? "requires_action" : "ok",
        run,
      };
    } catch (error) {
      this.logger(
        `ChatGPT writing run unavailable: ${error instanceof Error ? "driver-error" : "unknown-error"}`,
      );
      return safeStatus(error);
    }
  }

  async stop(input: WritingStopInput): Promise<WritingActionResult> {
    const read = await this.readTarget("writing.stop", input);
    if (!("snapshot" in read)) return read;
    const { snapshot, block } = read;
    const local = this.activeRuns.get(input.runId);
    const active = snapshot.activeRun;
    if (
      (!local && !active) ||
      (local && !identityMatches(local.target as WritingBlock, input)) ||
      (active && active.runId !== input.runId) ||
      (active && !identityMatches(active.target as WritingBlock, input))
    ) {
      return {
        ...resultBase("writing.stop", snapshot),
        status: "conflict",
        blockId: block.blockId,
        reason: "run-mismatch",
      };
    }
    if (!this.driver.stop)
      return {
        ...resultBase("writing.stop", snapshot),
        status: "unsupported",
        blockId: block.blockId,
        reason: "unsupported-action",
      };
    try {
      const stoppedResult = await this.driver.stop(input);
      const run = "runId" in stoppedResult ? stoppedResult : stoppedResult.activeRun;
      this.activeRuns.delete(input.runId);
      return {
        ...resultBase("writing.stop", snapshot),
        status: "stopped",
        blockId: block.blockId,
        run: run ?? { ...(active ?? local!), status: "stopped" },
      };
    } catch (error) {
      this.logger(
        `ChatGPT writing stop unavailable: ${error instanceof Error ? "driver-error" : "unknown-error"}`,
      );
      return safeStatus(error);
    }
  }

  async export(input: WritingExportInput): Promise<WritingActionResult> {
    return this.exportOperation("writing.export", input);
  }

  private async exportOperation(
    operation: "writing.export" | "codeBlock.save",
    input: WritingExportInput,
  ): Promise<WritingActionResult> {
    const read = await this.readTarget(operation, input);
    if (!("snapshot" in read)) return { ...read, operation };
    const { snapshot, block } = read;
    const result = withTarget(resultBase(operation, snapshot, Boolean(input.dryRun)), block);
    const challenge = bindApprovalChallenge(
      createWritingApprovalChallenge(
        operation,
        block.blockId,
        block.revisionHash,
        undefined,
        writingApprovalPayload(input, {
          outputPath: input.outputPath ?? null,
          mimeType: input.mimeType ?? null,
        }),
      ),
      input.approvalChallenge,
    );
    if (input.dryRun) {
      return {
        ...result,
        status: "requires_action",
        plan: planFor(
          operation,
          block,
          "Writing a file to the requested destination is consequential.",
        ),
        approvalChallenge: challenge,
      };
    }
    if (!this.approvalAuthority) {
      return {
        ...result,
        status: "requires_action",
        approvalChallenge: challenge,
        reason: "approval-authority-unavailable",
      };
    }
    const consumed = this.approvalAuthority.consumeGrant(input.approvalGrant, challenge, {
      principal: this.principal,
      session: this.session,
    });
    if (consumed.state !== "consumed") {
      return {
        ...result,
        status: "requires_action",
        approvalChallenge: challenge,
        reason: consumed.reason,
      };
    }
    if (!this.driver.export) {
      return { ...result, status: "unsupported", reason: "unsupported-action" };
    }
    try {
      const artifactValue = await this.driver.export(input);
      const artifact = artifactFor(artifactValue, block, input);
      if (!artifact) {
        return {
          ...result,
          status: "conflict",
          approvalChallenge: challenge,
          reason: "artifact-verification-failed",
        };
      }
      return { ...result, status: "ok", approvalChallenge: challenge, artifact };
    } catch (error) {
      this.logger(
        `ChatGPT writing export unavailable: ${error instanceof Error ? "driver-error" : "unknown-error"}`,
      );
      return safeStatus(error);
    }
  }

  async codeBlockList(input: CodeBlockListInput): Promise<WritingActionResult> {
    const result = await this.get(input);
    return {
      ...result,
      operation: "codeBlock.list",
      codeBlocks: (result.blocks ?? []).filter(
        (block): block is WritingCodeBlock => block.kind === "code",
      ),
    };
  }

  async codeBlockGet(input: CodeBlockGetInput): Promise<WritingActionResult> {
    const read = await this.readTarget("codeBlock.get", input);
    if (!("snapshot" in read)) return read;
    const { snapshot, block } = read;
    if (block.kind !== "code")
      return {
        ...resultBase("codeBlock.get", snapshot),
        status: "conflict",
        blockId: block.blockId,
        reason: "block-mismatch",
      };
    return withTarget({ ...resultBase("codeBlock.get", snapshot), status: "ok" }, block);
  }

  async codeBlockCopy(input: CodeBlockCopyInput): Promise<WritingActionResult> {
    const result = await this.codeBlockGet(input);
    return result.status === "ok"
      ? { ...result, operation: "codeBlock.copy" }
      : { ...result, operation: "codeBlock.copy" };
  }

  async codeBlockSave(input: CodeBlockSaveInput): Promise<WritingActionResult> {
    return this.exportOperation("codeBlock.save", input);
  }
}

export const writingGet = (service: ChatgptWritingService, input: WritingGetInput) =>
  service.get(input);
export const writingEdit = (service: ChatgptWritingService, input: WritingEditInput) =>
  service.edit(input);
export const writingPreview = (service: ChatgptWritingService, input: WritingPreviewInput) =>
  service.preview(input);
export const writingRun = (service: ChatgptWritingService, input: WritingRunInput) =>
  service.run(input);
export const writingStop = (service: ChatgptWritingService, input: WritingStopInput) =>
  service.stop(input);
export const writingExport = (service: ChatgptWritingService, input: WritingExportInput) =>
  service.export(input);
export const codeBlockList = (service: ChatgptWritingService, input: CodeBlockListInput) =>
  service.codeBlockList(input);
export const codeBlockGet = (service: ChatgptWritingService, input: CodeBlockGetInput) =>
  service.codeBlockGet(input);
export const codeBlockCopy = (service: ChatgptWritingService, input: CodeBlockCopyInput) =>
  service.codeBlockCopy(input);
export const codeBlockSave = (service: ChatgptWritingService, input: CodeBlockSaveInput) =>
  service.codeBlockSave(input);

export function buildWritingSnapshotExpression(): string {
  return `(() => {
    const visible = (node) => { if (!node || typeof node.getBoundingClientRect !== 'function') return false; const r = node.getBoundingClientRect(); if (!r.width || !r.height) return false; const s = getComputedStyle(node); return s.display !== 'none' && s.visibility !== 'hidden'; };
    const conversationId = location.pathname.match(/\\/c\\/([^/]+)/i)?.[1] || null;
    const nodes = Array.from(document.querySelectorAll('article, [data-message-author-role="assistant"], [data-testid^="conversation-turn-"]')).filter(visible);
    const messages = nodes.map((node, index) => ({
      conversationId,
      turnId: node.getAttribute('data-testid') || node.id || ('turn-' + index),
      messageId: node.getAttribute('data-message-id') || node.getAttribute('data-testid') || ('message-' + index),
      index,
      html: node.innerHTML || '',
      revisionHash: null,
    }));
    const controls = {
      writing: nodes.length > 0,
      edit: Boolean(document.querySelector('[aria-label*="Edit" i], button[data-testid*="edit" i]')),
      preview: Boolean(document.querySelector('[aria-label*="Preview" i], button[data-testid*="preview" i]')),
      run: Boolean(document.querySelector('[aria-label*="Run" i], button[data-testid*="run" i]')),
      stop: Boolean(document.querySelector('[aria-label*="Stop" i], button[data-testid*="stop" i]')),
      export: Boolean(document.querySelector('[aria-label*="Download" i], button[data-testid*="download" i]')),
      codeBlock: Boolean(document.querySelector('pre code')),
    };
    return { href: location.href, conversationId, messages, controls };
  })()`;
}

function snapshotFromRuntime(value: unknown, conversationId?: string): ChatgptWritingSnapshot {
  const raw =
    value && typeof value === "object"
      ? (value as {
          href?: unknown;
          conversationId?: unknown;
          messages?: unknown;
          controls?: unknown;
        })
      : {};
  const resolvedConversationId =
    asString(raw.conversationId) ?? conversationId ?? conversationIdFromUrl(asString(raw.href));
  const controlsRaw =
    raw.controls && typeof raw.controls === "object"
      ? (raw.controls as Record<string, unknown>)
      : {};
  const controls = {
    writing: Boolean(controlsRaw.writing),
    edit: Boolean(controlsRaw.edit),
    preview: Boolean(controlsRaw.preview),
    run: Boolean(controlsRaw.run),
    stop: Boolean(controlsRaw.stop),
    export: Boolean(controlsRaw.export),
    codeBlock: Boolean(controlsRaw.codeBlock),
  };
  const messages: ChatgptWritingMessage[] = [];
  for (const candidate of Array.isArray(raw.messages) ? raw.messages : []) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Record<string, unknown>;
    const html = typeof item.html === "string" ? item.html : "";
    const messageConversationId =
      asString(item.conversationId) ?? resolvedConversationId ?? UNKNOWN_ID;
    const turnId = asString(item.turnId) ?? UNKNOWN_ID;
    const messageId = asString(item.messageId) ?? UNKNOWN_ID;
    const index = typeof item.index === "number" ? item.index : messages.length;
    const extracted = extractWritingBlocks({
      html,
      conversationId: messageConversationId,
      turnId,
      messageId,
      turnIndex: index,
      revisionHash: asString(item.revisionHash),
    });
    messages.push({
      conversationId: messageConversationId,
      turnId,
      messageId,
      index,
      html,
      revisionHash: extracted.revisionHash,
      responseOutput: extracted.responseOutput,
      blocks: extracted.blocks,
    });
  }
  const blocks = messages.flatMap((message) => message.blocks);
  const latest = messages.at(-1);
  const status: WritingStatus = !resolvedConversationId || !controls.writing ? "unsupported" : "ok";
  return {
    status,
    conversationId: resolvedConversationId,
    conversationUrl: asString(raw.href),
    turnId: latest?.turnId ?? null,
    messageId: latest?.messageId ?? null,
    revisionHash: latest?.revisionHash ?? null,
    blocks,
    messages,
    responseOutput: latest?.responseOutput,
    provenance: latest?.blocks[0]?.provenance,
    capability: {
      controls,
      supported: status === "ok",
      ...(status === "unsupported" ? { reason: "missing-controls" as const } : {}),
    },
    activeRun: null,
  };
}

export function createRuntimeWritingService(
  options: WritingRuntimeOptions & { conversationId?: string; logger?: BrowserLogger },
): ChatgptWritingService {
  const driver: WritingBrowserDriver = {
    async get(input) {
      const evaluated = await options.Runtime.evaluate({
        expression: buildWritingSnapshotExpression(),
        returnByValue: true,
      });
      const snapshot = snapshotFromRuntime(evaluated.result?.value, input.conversationId);
      if (input.conversationId && snapshot.conversationId !== input.conversationId)
        return {
          ...snapshot,
          status: "conflict",
          capability: { ...snapshot.capability, reason: "conversation-mismatch" },
        };
      return snapshot;
    },
  };
  return new ChatgptWritingService(
    driver,
    options.logger,
    options.approvalAuthority,
    options.principal,
    options.session,
  );
}

export function writingSnapshotFromMessages(
  messages: Array<{
    html: string;
    conversationId: string;
    turnId: string;
    messageId: string;
    index?: number;
    revisionHash?: string;
  }>,
  controls?: Partial<WritingCapabilityEvidence["controls"]>,
): ChatgptWritingSnapshot {
  const normalized = messages.map((message, index) => {
    const extracted = extractWritingBlocks({ ...message, turnIndex: message.index ?? index });
    return {
      ...message,
      index: message.index ?? index,
      revisionHash: extracted.revisionHash,
      responseOutput: extracted.responseOutput,
      blocks: extracted.blocks,
    };
  });
  const latest = normalized.at(-1);
  const mergedControls = {
    writing: true,
    edit: true,
    preview: true,
    run: true,
    stop: true,
    export: true,
    codeBlock: true,
    ...controls,
  };
  const supported = Boolean(mergedControls.writing);
  return {
    status: supported ? "ok" : "unsupported",
    conversationId: latest?.conversationId ?? null,
    conversationUrl: null,
    turnId: latest?.turnId ?? null,
    messageId: latest?.messageId ?? null,
    revisionHash: latest?.revisionHash ?? null,
    blocks: normalized.flatMap((message) => message.blocks),
    messages: normalized,
    responseOutput: latest?.responseOutput,
    provenance: latest?.blocks[0]?.provenance,
    capability: {
      controls: mergedControls,
      supported,
      ...(supported ? {} : { reason: "missing-controls" as const }),
    },
    activeRun: null,
  };
}
