import { constants as fsConstants, createReadStream, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rm, unlink, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserAttachment, BrowserLogger } from "../types.js";
import type {
  ChatgptFileAssociation,
  ChatgptFileDownload,
  ChatgptFileDownloadPolicy,
  ChatgptFileError,
  ChatgptFileErrorClassification,
  ChatgptFileEvidence,
  ChatgptFileFingerprint,
  ChatgptFilePreflightResult,
  ChatgptFilePreflightStatus,
  ChatgptFileQuotaLane,
  ChatgptFileQuotaObservation,
  ChatgptFileRateLimitObservation,
  ChatgptFileRecord,
  ChatgptFileProgress,
  ChatgptFileUploadResult,
  ChatgptFileUploadState,
} from "./types.js";

export * from "./types.js";

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".c": "text/x-c",
  ".cc": "text/x-c++",
  ".cpp": "text/x-c++",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".py": "text/x-python",
  ".rtf": "application/rtf",
  ".svg": "image/svg+xml",
  ".text": "text/plain",
  ".toml": "application/toml",
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

const DEFAULT_LANE = "file_upload";
const SAFE_ERROR_MESSAGES: Readonly<Record<ChatgptFileError["code"], string>> = {
  unsupported: "ChatGPT does not support this file type.",
  too_large: "The file exceeds the observed ChatGPT size limit.",
  quota_exhausted: "The observed ChatGPT file quota is exhausted.",
  rate_limited: "ChatGPT file uploads are rate limited; retry after the supplied delay.",
  requires_action: "ChatGPT requires an account or browser action before uploading files.",
  disconnected: "The ChatGPT browser connection was lost; reattach and retry the file operation.",
  association_mismatch: "The uploaded file could not be matched to the exact ChatGPT turn.",
  transport: "The ChatGPT file transfer failed without exposing sensitive browser details.",
  unknown: "The ChatGPT file operation failed without exposing sensitive browser details.",
};

export interface ChatgptFilePreflightOptions {
  lane?: ChatgptFileQuotaLane;
  mimeType?: string;
  supportedMimeTypes?: readonly string[];
  supportedExtensions?: readonly string[];
  /** A limit is used only when explicitly observed or supplied by the caller. */
  maxBytes?: number;
  quota?: ChatgptFileQuotaObservation | null;
  rateLimit?: ChatgptFileRateLimitObservation | null;
  requiresAction?: string | null;
  observedAt?: string;
}

export interface ChatgptFileStreamContext {
  fingerprint: ChatgptFileFingerprint;
  mimeType?: string;
  signal?: AbortSignal;
  onProgress: (progress: ChatgptFileProgress) => void;
}

export interface ChatgptFileTransportResult {
  fileId?: string;
  name?: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface ChatgptFileUploadOptions {
  file: string | BrowserAttachment | ChatgptFileFingerprint;
  preflight?: ChatgptFilePreflightOptions | ChatgptFilePreflightResult;
  transport: (
    stream: AsyncIterable<Uint8Array>,
    context: ChatgptFileStreamContext,
  ) => Promise<ChatgptFileTransportResult>;
  submit?: (input: {
    fingerprint: ChatgptFileFingerprint;
    fileId?: string;
    signal?: AbortSignal;
  }) => Promise<{ conversationId: string; turnId: string; messageId: string }>;
  associate?: (input: {
    fingerprint: ChatgptFileFingerprint;
    fileId?: string;
    conversationId: string;
    turnId: string;
    messageId: string;
    signal?: AbortSignal;
  }) => Promise<ChatgptFileAssociation>;
  signal?: AbortSignal;
  onProgress?: (progress: ChatgptFileProgress) => void;
  logger?: BrowserLogger;
}

export interface ChatgptFileAssociationExpectation {
  fingerprint: ChatgptFileFingerprint;
  conversationId: string;
  turnId: string;
  messageId: string;
  fileId?: string;
}

export interface ChatgptFileAssociationMatch {
  matched: boolean;
  associations: ChatgptFileAssociation[];
  missing: ChatgptFileAssociationExpectation[];
  unexpected: ChatgptFileAssociation[];
}

export interface ChatgptFileGetOptions {
  fileId: string;
  get: (fileId: string) => Promise<ChatgptFileRecord>;
  expected?: Partial<Pick<ChatgptFileRecord, "name" | "sizeBytes" | "sha256">>;
}

export interface ChatgptFileFingerprintOptions {
  maxBytes?: number;
}

export interface ChatgptFileDownloadOptions {
  fileId: string;
  destinationPath: string;
  policy: ChatgptFileDownloadPolicy;
  get?: (fileId: string) => Promise<ChatgptFileRecord>;
  download: (input: {
    fileId: string;
    record?: ChatgptFileRecord;
    signal?: AbortSignal;
  }) => Promise<AsyncIterable<Uint8Array> | Uint8Array | Buffer | string>;
  signal?: AbortSignal;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeExtension(value: string): string {
  const extension = value.trim().toLowerCase();
  return extension.startsWith(".") ? extension : `.${extension}`;
}

function extensionForFile(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

export function inferChatgptFileMimeType(fileName: string): string | undefined {
  return MIME_BY_EXTENSION[extensionForFile(fileName)];
}

function displayNameForFile(file: string | BrowserAttachment): string {
  const displayPath = typeof file === "string" ? file : file.displayPath || file.path;
  return path.basename(displayPath) || path.basename(filePathForInput(file));
}

function filePathForInput(file: string | BrowserAttachment): string {
  return typeof file === "string" ? file : file.path;
}

function fingerprintMatches(
  actual: ChatgptFileFingerprint,
  expected: ChatgptFileFingerprint,
): boolean {
  return (
    actual.absolutePath === expected.absolutePath &&
    actual.displayName === expected.displayName &&
    actual.sizeBytes === expected.sizeBytes &&
    actual.modifiedAtMs === expected.modifiedAtMs &&
    actual.sha256 === expected.sha256 &&
    actual.device === expected.device &&
    actual.inode === expected.inode
  );
}

function pathIsWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function assertNoSymlinkComponents(inputPath: string): Promise<void> {
  const resolved = path.resolve(inputPath);
  const tempRoot = path.resolve(os.tmpdir());
  const scanRoot = pathIsWithin(tempRoot, resolved) ? tempRoot : path.parse(resolved).root;
  let current = scanRoot;
  for (const segment of path.relative(scanRoot, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error("Symbolic-link path components are not allowed.");
  }
}

async function openRegularFileForRead(
  inputPath: string,
): Promise<{ handle: FileHandle; stats: Stats }> {
  await assertNoSymlinkComponents(inputPath);
  const handle = await open(inputPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("The attachment path is not a regular file.");
    return { handle, stats };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** Hashes as a stream and rejects a file changed while it was being read. */
export async function fingerprintChatgptFile(
  file: string | BrowserAttachment,
  options: ChatgptFileFingerprintOptions = {},
): Promise<ChatgptFileFingerprint> {
  const inputPath = path.resolve(filePathForInput(file));
  const maxBytes = options.maxBytes;
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new Error("The maximum file size must be a non-negative safe integer.");
  }
  const { handle, stats: before } = await openRegularFileForRead(inputPath);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    if (maxBytes !== undefined && before.size > maxBytes) {
      throw new Error("The attachment exceeds the configured maximum size.");
    }
    for await (const chunk of createReadStream(inputPath, { fd: handle.fd, autoClose: false })) {
      const bytes = chunk as Uint8Array;
      sizeBytes += bytes.byteLength;
      if (maxBytes !== undefined && sizeBytes > maxBytes) {
        throw new Error("The attachment exceeds the configured maximum size.");
      }
      hash.update(bytes);
    }
    const after = await handle.stat();
    const unchanged =
      before.size === after.size &&
      sizeBytes === after.size &&
      before.mtimeMs === after.mtimeMs &&
      Number(before.dev) === Number(after.dev) &&
      Number(before.ino) === Number(after.ino);
    if (!unchanged) throw new Error("The attachment changed while it was being fingerprinted.");
    return Object.freeze({
      absolutePath: inputPath,
      displayName: displayNameForFile(file),
      sizeBytes: after.size,
      modifiedAtMs: after.mtimeMs,
      device: Number(after.dev),
      inode: Number(after.ino),
      sha256: hash.digest("hex"),
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function normalizeQuotaObservation(
  observation: ChatgptFileQuotaObservation | null | undefined,
  lane: ChatgptFileQuotaLane,
  observedAt: string,
): ChatgptFileQuotaObservation | undefined {
  if (!observation || (observation.lane && observation.lane !== lane)) return undefined;
  const source = observation.source;
  return {
    lane: observation.lane || lane,
    observedAt: observation.observedAt || observedAt,
    source,
    ...(asNonNegativeNumber(observation.used) === undefined
      ? {}
      : { used: asNonNegativeNumber(observation.used) }),
    ...(asNonNegativeNumber(observation.limit) === undefined
      ? {}
      : { limit: asNonNegativeNumber(observation.limit) }),
    ...(asNonNegativeNumber(observation.remaining) === undefined
      ? {}
      : { remaining: asNonNegativeNumber(observation.remaining) }),
    ...(asNonEmptyString(observation.resetAt)
      ? { resetAt: asNonEmptyString(observation.resetAt) }
      : {}),
  };
}

function normalizeRateLimitObservation(
  observation: ChatgptFileRateLimitObservation | null | undefined,
  lane: ChatgptFileQuotaLane,
  observedAt: string,
): ChatgptFileRateLimitObservation | undefined {
  if (!observation || (observation.lane && observation.lane !== lane)) return undefined;
  const retryAfterMs = asNonNegativeNumber(observation.retryAfterMs);
  return {
    lane: observation.lane || lane,
    observedAt: observation.observedAt || observedAt,
    source: observation.source,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function quotaExhausted(quota?: ChatgptFileQuotaObservation): boolean {
  if (!quota) return false;
  if (quota.remaining !== undefined) return quota.remaining <= 0;
  return quota.limit !== undefined && quota.used !== undefined && quota.used >= quota.limit;
}

/**
 * Performs only evidence-backed checks. In particular, no default size or quota
 * is inferred when ChatGPT did not expose one.
 */
export async function preflightChatgptFile(
  file: string | BrowserAttachment | ChatgptFileFingerprint,
  options: ChatgptFilePreflightOptions = {},
): Promise<ChatgptFilePreflightResult> {
  const fingerprint =
    typeof file === "object" && file !== null && "sha256" in file
      ? file
      : await fingerprintChatgptFile(file);
  const lane = options.lane || DEFAULT_LANE;
  const observedAt = options.observedAt || new Date().toISOString();
  const extension = extensionForFile(fingerprint.displayName);
  const mimeType = options.mimeType || inferChatgptFileMimeType(fingerprint.displayName);
  const supportedExtensions = options.supportedExtensions?.map(normalizeExtension);
  const supportedMimeTypes = options.supportedMimeTypes?.map((value) => value.trim().toLowerCase());
  const quota = normalizeQuotaObservation(options.quota, lane, observedAt);
  const rateLimit = normalizeRateLimitObservation(options.rateLimit, lane, observedAt);
  const maxBytes = asNonNegativeNumber(options.maxBytes);
  const evidence: ChatgptFileEvidence = {
    observedAt,
    lane,
    sizeBytes: fingerprint.sizeBytes,
    ...(mimeType ? { mimeType } : {}),
    ...(extension ? { extension } : {}),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(quota ? { quota } : {}),
    ...(rateLimit ? { rateLimit } : {}),
    ...(options.requiresAction ? { action: options.requiresAction } : {}),
  };
  let status: ChatgptFilePreflightStatus = "accepted";
  let reason: string | undefined;
  if (supportedExtensions && (!extension || !supportedExtensions.includes(extension))) {
    status = "unsupported";
    reason = "extension-not-supported";
  } else if (
    supportedMimeTypes &&
    (!mimeType || !supportedMimeTypes.includes(mimeType.toLowerCase()))
  ) {
    status = "unsupported";
    reason = "mime-type-not-supported";
  } else if (maxBytes !== undefined && fingerprint.sizeBytes > maxBytes) {
    status = "too_large";
    reason = "size-exceeds-observed-limit";
  } else if (quotaExhausted(quota)) {
    status = "quota_exhausted";
    reason = "observed-quota-exhausted";
  } else if (rateLimit) {
    status = "rate_limited";
    reason = "observed-rate-limit";
  } else if (options.requiresAction) {
    status = "requires_action";
    reason = "action-required";
  }
  return Object.freeze({
    operation: "file.preflight",
    status,
    fingerprint,
    evidence: Object.freeze({ ...evidence, ...(reason ? { reason } : {}) }),
    ...(rateLimit?.retryAfterMs === undefined ? {} : { retryAfterMs: rateLimit.retryAfterMs }),
  });
}

function progress(
  state: ChatgptFileUploadState,
  loadedBytes: number,
  totalBytes: number,
): ChatgptFileProgress {
  const loaded = Math.max(0, Math.min(totalBytes, Math.floor(loadedBytes)));
  return Object.freeze({
    state,
    loadedBytes: loaded,
    totalBytes,
    percent:
      totalBytes > 0 ? Math.floor((loaded / totalBytes) * 100) : totalBytes === 0 ? 100 : null,
    updatedAt: new Date().toISOString(),
  });
}

function errorFromClassification(classification: ChatgptFileErrorClassification): ChatgptFileError {
  return Object.freeze({
    code: classification.code,
    message: classification.message,
    ...(classification.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: classification.retryAfterMs }),
    ...(classification.lane ? { lane: classification.lane } : {}),
    ...(classification.quota ? { quota: classification.quota } : {}),
  });
}

function failedUpload(
  fingerprint: ChatgptFileFingerprint,
  progressStates: readonly ChatgptFileProgress[],
  classification: ChatgptFileErrorClassification,
): ChatgptFileUploadResult {
  const failureProgress = [
    ...progressStates,
    progress("failed", progressStates.at(-1)?.loadedBytes ?? 0, fingerprint.sizeBytes),
  ];
  return Object.freeze({
    operation: "file.upload",
    state: "failed",
    fingerprint,
    progress: Object.freeze(failureProgress),
    error: errorFromClassification(classification),
  });
}

async function* streamFingerprint(
  fingerprint: ChatgptFileFingerprint,
  emit: (loaded: number) => void,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let loaded = 0;
  for await (const chunk of createReadStream(fingerprint.absolutePath)) {
    if (signal?.aborted) throw new Error("The file transfer was aborted.");
    const bytes = chunk as Uint8Array;
    loaded += bytes.byteLength;
    emit(loaded);
    yield bytes;
  }
  if (loaded !== fingerprint.sizeBytes) throw new Error("The file changed during upload.");
}

/** Streams bytes to an injected browser transport without creating a base64 copy. */
export async function uploadChatgptFile(
  options: ChatgptFileUploadOptions,
): Promise<ChatgptFileUploadResult> {
  let fingerprint: ChatgptFileFingerprint;
  try {
    fingerprint =
      typeof options.file === "object" && options.file !== null && "sha256" in options.file
        ? options.file
        : await fingerprintChatgptFile(options.file);
    const latest = await fingerprintChatgptFile(fingerprint.absolutePath);
    if (!fingerprintMatches(latest, fingerprint)) {
      return failedUpload(fingerprint, [], {
        code: "transport",
        retryable: false,
        message: "The local attachment changed before upload.",
      });
    }
  } catch {
    const fallback =
      typeof options.file === "object" && options.file !== null && "sha256" in options.file
        ? options.file
        : undefined;
    if (!fallback) throw new Error("Unable to fingerprint the local attachment.");
    return failedUpload(fallback, [], {
      code: "transport",
      retryable: false,
      message: SAFE_ERROR_MESSAGES.transport,
    });
  }

  const first = progress("staged", 0, fingerprint.sizeBytes);
  const progressStates: ChatgptFileProgress[] = [first];
  options.onProgress?.(first);
  let preflight: ChatgptFilePreflightResult;
  try {
    preflight =
      options.preflight && "status" in options.preflight
        ? options.preflight
        : await preflightChatgptFile(fingerprint, options.preflight);
  } catch {
    return failedUpload(fingerprint, progressStates, {
      code: "transport",
      retryable: false,
      message: SAFE_ERROR_MESSAGES.transport,
    });
  }
  if (preflight.status !== "accepted") {
    const code = preflight.status === "rate_limited" ? "rate_limited" : preflight.status;
    return failedUpload(fingerprint, progressStates, {
      code,
      retryable: code === "rate_limited",
      retryAfterMs: preflight.retryAfterMs,
      lane: preflight.evidence.lane,
      quota: preflight.evidence.quota,
      message: SAFE_ERROR_MESSAGES[code],
    });
  }

  const emit = (next: ChatgptFileProgress) => {
    progressStates.push(next);
    options.onProgress?.(next);
  };
  emit(progress("streaming", 0, fingerprint.sizeBytes));
  try {
    const transport = await options.transport(
      streamFingerprint(
        fingerprint,
        (loaded) => emit(progress("streaming", loaded, fingerprint.sizeBytes)),
        options.signal,
      ),
      {
        fingerprint,
        ...(preflight.evidence.mimeType ? { mimeType: preflight.evidence.mimeType } : {}),
        signal: options.signal,
        onProgress: (item) => {
          const next = progress("streaming", item.loadedBytes, fingerprint.sizeBytes);
          emit(next);
        },
      },
    );
    const streamedBytes = progressStates.at(-1)?.loadedBytes ?? 0;
    if (streamedBytes !== fingerprint.sizeBytes) {
      throw new Error("The file transport did not consume the attachment stream.");
    }
    emit(progress("ready", streamedBytes, fingerprint.sizeBytes));
    let submitted: { conversationId: string; turnId: string; messageId: string } | undefined;
    if (options.submit) {
      submitted = await options.submit({
        fingerprint,
        fileId: transport.fileId,
        signal: options.signal,
      });
      emit(progress("submitted", fingerprint.sizeBytes, fingerprint.sizeBytes));
    }
    if (!submitted) {
      return Object.freeze({
        operation: "file.upload",
        state: "ready",
        fingerprint,
        progress: Object.freeze(progressStates),
        ...(transport.fileId ? { fileId: transport.fileId } : {}),
      });
    }
    let association: ChatgptFileAssociation | undefined;
    if (options.associate) {
      association = await options.associate({
        fingerprint,
        fileId: transport.fileId,
        ...submitted,
        signal: options.signal,
      });
      const match = matchChatgptFileAssociations(
        [{ fingerprint, ...submitted, ...(transport.fileId ? { fileId: transport.fileId } : {}) }],
        [association],
      );
      if (!match.matched) throw new Error(SAFE_ERROR_MESSAGES.association_mismatch);
      emit(progress("associated", fingerprint.sizeBytes, fingerprint.sizeBytes));
      return Object.freeze({
        operation: "file.upload",
        state: "associated",
        fingerprint,
        progress: Object.freeze(progressStates),
        ...(transport.fileId ? { fileId: transport.fileId } : {}),
        association,
        associations: Object.freeze([association]),
      });
    }
    return Object.freeze({
      operation: "file.upload",
      state: "submitted",
      fingerprint,
      progress: Object.freeze(progressStates),
      ...(transport.fileId ? { fileId: transport.fileId } : {}),
    });
  } catch (error) {
    return failedUpload(fingerprint, progressStates, classifyChatgptFileError(error));
  }
}

function associationMatches(
  expected: ChatgptFileAssociationExpectation,
  observed: ChatgptFileAssociation,
): boolean {
  return (
    expected.conversationId === observed.conversationId &&
    expected.turnId === observed.turnId &&
    expected.messageId === observed.messageId &&
    expected.fingerprint.displayName === observed.name &&
    expected.fingerprint.sizeBytes === observed.sizeBytes &&
    expected.fingerprint.sha256 === observed.sha256 &&
    (!expected.fileId || expected.fileId === observed.fileId)
  );
}

/** Matches all files without relying on upload or DOM order. */
export function matchChatgptFileAssociations(
  expected: readonly ChatgptFileAssociationExpectation[],
  observed: readonly ChatgptFileAssociation[],
): ChatgptFileAssociationMatch {
  const used = new Set<number>();
  const associations: ChatgptFileAssociation[] = [];
  const missing: ChatgptFileAssociationExpectation[] = [];
  for (const item of expected) {
    const index = observed.findIndex(
      (candidate, candidateIndex) =>
        !used.has(candidateIndex) && associationMatches(item, candidate),
    );
    if (index < 0) missing.push(item);
    else {
      used.add(index);
      associations.push(observed[index]);
    }
  }
  const unexpected = observed.filter((_candidate, index) => !used.has(index));
  return {
    matched: missing.length === 0 && unexpected.length === 0,
    associations,
    missing,
    unexpected,
  };
}

export function verifyChatgptFileAssociations(
  expected: readonly ChatgptFileAssociationExpectation[],
  observed: readonly ChatgptFileAssociation[],
): ChatgptFileAssociation[] {
  const match = matchChatgptFileAssociations(expected, observed);
  if (!match.matched) throw new Error(SAFE_ERROR_MESSAGES.association_mismatch);
  return match.associations;
}

function normalizeRecord(value: ChatgptFileRecord): ChatgptFileRecord {
  if (
    !asNonEmptyString(value.fileId) ||
    !asNonEmptyString(value.name) ||
    !asNonNegativeNumber(value.sizeBytes)
  ) {
    throw new Error("ChatGPT returned incomplete file metadata.");
  }
  return Object.freeze({
    fileId: value.fileId,
    name: value.name,
    sizeBytes: value.sizeBytes,
    ...(asNonEmptyString(value.sha256) ? { sha256: value.sha256 } : {}),
    ...(asNonEmptyString(value.mimeType) ? { mimeType: value.mimeType } : {}),
    ...(asNonEmptyString(value.conversationId) ? { conversationId: value.conversationId } : {}),
    ...(asNonEmptyString(value.turnId) ? { turnId: value.turnId } : {}),
    ...(asNonEmptyString(value.messageId) ? { messageId: value.messageId } : {}),
  });
}

export async function getChatgptFile(options: ChatgptFileGetOptions): Promise<ChatgptFileRecord> {
  try {
    const record = normalizeRecord(await options.get(options.fileId));
    const expected = options.expected;
    if (expected?.name !== undefined && expected.name !== record.name)
      throw new Error("File name did not match.");
    if (expected?.sizeBytes !== undefined && expected.sizeBytes !== record.sizeBytes)
      throw new Error("File size did not match.");
    if (expected?.sha256 !== undefined && expected.sha256 !== record.sha256)
      throw new Error("File hash did not match.");
    return record;
  } catch {
    throw new Error(SAFE_ERROR_MESSAGES.unknown);
  }
}

async function* bytesFromDownload(
  value: AsyncIterable<Uint8Array> | Uint8Array | Buffer | string,
): AsyncGenerator<Uint8Array> {
  if (typeof value === "string") {
    for await (const chunk of createReadStream(value)) yield chunk as Uint8Array;
    return;
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    yield value;
    return;
  }
  for await (const chunk of value) yield chunk;
}

function validateDownloadPolicy(policy: ChatgptFileDownloadPolicy): void {
  if (!Number.isSafeInteger(policy.maxDownloadBytes) || policy.maxDownloadBytes <= 0) {
    throw new Error("The configured maximum download size is invalid.");
  }
  if (typeof policy.approvedOutputRoot !== "string" || !policy.approvedOutputRoot.trim()) {
    throw new Error("The configured download output root is invalid.");
  }
}

function hasTraversalSegment(value: string): boolean {
  return value.split(/[\\/]/u).some((segment) => segment === "..");
}

async function ensureOutputParent(rootPath: string, parentPath: string): Promise<void> {
  const relative = path.relative(rootPath, parentPath);
  let current = rootPath;
  for (const segment of relative ? relative.split(path.sep) : []) {
    if (!segment || segment === ".") continue;
    current = path.join(current, segment);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
      entry = await lstat(current);
    }
    if (entry.isSymbolicLink()) throw new Error("Symbolic-link output components are not allowed.");
    if (!entry.isDirectory()) throw new Error("The download output parent is not a directory.");
  }
}

async function resolveDownloadDestination(
  destinationPath: string,
  policy: ChatgptFileDownloadPolicy,
): Promise<{ rootPath: string; destinationPath: string; parentPath: string }> {
  validateDownloadPolicy(policy);
  if (
    !destinationPath.trim() ||
    destinationPath.includes("\0") ||
    hasTraversalSegment(destinationPath)
  ) {
    throw new Error("The download destination is outside the approved output root.");
  }
  const rootPath = path.resolve(policy.approvedOutputRoot);
  await assertNoSymlinkComponents(rootPath);
  const rootStats = await lstat(rootPath);
  if (!rootStats.isDirectory()) throw new Error("The approved output root is not a directory.");
  const resolved = path.isAbsolute(destinationPath)
    ? path.resolve(destinationPath)
    : path.resolve(rootPath, destinationPath);
  const relative = path.relative(rootPath, resolved);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("The download destination is outside the approved output root.");
  }
  const parentPath = path.dirname(resolved);
  await ensureOutputParent(rootPath, parentPath);
  await assertNoSymlinkComponents(parentPath);
  try {
    await lstat(resolved);
    throw new Error("The download destination already exists.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { rootPath, destinationPath: resolved, parentPath };
}

async function createExclusiveTempFile(
  parentPath: string,
  baseName: string,
): Promise<{
  path: string;
  handle: FileHandle;
}> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const temporaryPath = path.join(parentPath, `.${baseName}.${randomUUID()}.tmp`);
    try {
      return { path: temporaryPath, handle: await open(temporaryPath, "wx", 0o600) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Unable to create an exclusive temporary download.");
}

export async function downloadChatgptFile(
  options: ChatgptFileDownloadOptions,
): Promise<ChatgptFileDownload> {
  let record: ChatgptFileRecord | undefined;
  let temporaryPath: string | undefined;
  let temporaryHandle: FileHandle | undefined;
  try {
    const destination = await resolveDownloadDestination(options.destinationPath, options.policy);
    if (options.signal?.aborted) throw new Error("The file download was aborted.");
    if (options.get) record = await getChatgptFile({ fileId: options.fileId, get: options.get });
    if (record && record.sizeBytes > options.policy.maxDownloadBytes) {
      throw new Error("The download exceeds the configured maximum size.");
    }

    const temporary = await createExclusiveTempFile(
      destination.parentPath,
      path.basename(destination.destinationPath),
    );
    temporaryPath = temporary.path;
    temporaryHandle = temporary.handle;
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of bytesFromDownload(
      await options.download({ fileId: options.fileId, record, signal: options.signal }),
    )) {
      if (options.signal?.aborted) throw new Error("The file download was aborted.");
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (bytes.byteLength > options.policy.maxDownloadBytes - sizeBytes) {
        throw new Error("The download exceeds the configured maximum size.");
      }
      await temporaryHandle.write(bytes);
      hash.update(bytes);
      sizeBytes += bytes.byteLength;
    }
    if (options.signal?.aborted) throw new Error("The file download was aborted.");
    const sha256 = hash.digest("hex");
    if (record && (record.sizeBytes !== sizeBytes || (record.sha256 && record.sha256 !== sha256))) {
      throw new Error("Downloaded file metadata did not match ChatGPT metadata.");
    }
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await link(temporaryPath, destination.destinationPath);
    await unlink(temporaryPath);
    temporaryPath = undefined;
    const name = record?.name || path.basename(destination.destinationPath);
    const mimeType =
      record?.mimeType ?? inferChatgptFileMimeType(name) ?? "application/octet-stream";
    return Object.freeze({
      operation: "file.download",
      fileId: options.fileId,
      name,
      mimeType,
      sizeBytes,
      sha256,
      downloadedPath: destination.destinationPath,
      provenance: Object.freeze({
        source: "chatgpt-file" as const,
        fileId: options.fileId,
        name,
        ...(record?.conversationId ? { conversationId: record.conversationId } : {}),
        ...(record?.turnId ? { turnId: record.turnId } : {}),
        ...(record?.messageId ? { messageId: record.messageId } : {}),
      }),
    });
  } catch {
    await temporaryHandle?.close().catch(() => undefined);
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new Error(SAFE_ERROR_MESSAGES.transport);
  }
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "detail", "reason", "code", "statusText"]) {
    const nested = record[key];
    if (typeof nested === "string" && nested.trim()) return nested;
    if (nested && typeof nested === "object") {
      const nestedText = textFromUnknown(nested);
      if (nestedText) return nestedText;
    }
  }
  return "";
}

function numericFromKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = asNonNegativeNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const candidate = headers as { get?: (key: string) => string | null } & Record<string, unknown>;
  if (typeof candidate.get === "function") return asNonEmptyString(candidate.get(name));
  for (const [key, value] of Object.entries(candidate))
    if (key.toLowerCase() === name.toLowerCase()) return asNonEmptyString(value);
  return undefined;
}

export function parseRetryAfterMs(value: unknown, nowMs = Date.now()): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return Math.ceil(value * 1000);
  const text = asNonEmptyString(value);
  if (!text) return undefined;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const dateMs = Date.parse(text);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : undefined;
}

function retryAfterFromText(text: string): number | undefined {
  const match = text.match(/retry[- ]?after[^0-9]*(\d+(?:\.\d+)?)\s*(ms|s|seconds?)?/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return match[2]?.toLowerCase() === "ms" ? Math.ceil(value) : Math.ceil(value * 1000);
}

function classifyCode(text: string, status?: number): ChatgptFileError["code"] {
  const lower = text.toLowerCase();
  if (status === 413 || /too[ _-]?large|size[ _-]?(?:limit|exceed)|maximum file/.test(lower))
    return "too_large";
  if (/unsupported|not supported|invalid (?:mime|extension|file type)|file type/.test(lower))
    return "unsupported";
  if (/quota|limit reached|storage full|remaining[=: ]+0/.test(lower)) return "quota_exhausted";
  if (status === 429 || /rate[ _-]?limit|too many requests|retry[ _-]?after/.test(lower))
    return "rate_limited";
  if (/login|log in|sign[ _-]?in|auth|verify|challenge|permission/.test(lower))
    return "requires_action";
  if (/disconnect|target closed|websocket|connection lost|network/.test(lower))
    return "disconnected";
  return "unknown";
}

/** Parses browser/HTTP rejection details into a stable, sanitized classification. */
export function classifyChatgptFileError(
  error: unknown,
  lane = DEFAULT_LANE,
): ChatgptFileErrorClassification {
  const record =
    error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const responseRecord =
    record?.response && typeof record.response === "object"
      ? (record.response as Record<string, unknown>)
      : undefined;
  const status =
    typeof record?.status === "number"
      ? record.status
      : typeof responseRecord?.status === "number"
        ? responseRecord.status
        : undefined;
  const body = record?.body ?? record?.data ?? responseRecord?.body ?? record?.response ?? error;
  const bodyRecord =
    body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  const text = `${textFromUnknown(error)} ${textFromUnknown(body)}`.trim();
  const code = classifyCode(text, status);
  const now = new Date().toISOString();
  const quotaRaw =
    bodyRecord?.quota && typeof bodyRecord.quota === "object"
      ? (bodyRecord.quota as Record<string, unknown>)
      : bodyRecord;
  const quota =
    quotaRaw &&
    (numericFromKeys(quotaRaw, ["used", "usage"]) !== undefined ||
      numericFromKeys(quotaRaw, ["limit", "max"]) !== undefined ||
      numericFromKeys(quotaRaw, ["remaining"]) !== undefined)
      ? normalizeQuotaObservation(
          {
            lane: asNonEmptyString(quotaRaw.lane) || lane,
            observedAt: now,
            source: "response",
            used: numericFromKeys(quotaRaw, ["used", "usage"]),
            limit: numericFromKeys(quotaRaw, ["limit", "max"]),
            remaining: numericFromKeys(quotaRaw, ["remaining"]),
            resetAt: asNonEmptyString(quotaRaw.resetAt),
          },
          lane,
          now,
        )
      : undefined;
  const headers = record?.headers ?? responseRecord?.headers;
  let retryAfterMs: number | undefined;
  if (typeof record?.retryAfterMs === "number")
    retryAfterMs = asNonNegativeNumber(record.retryAfterMs);
  else if (typeof bodyRecord?.retryAfterMs === "number")
    retryAfterMs = asNonNegativeNumber(bodyRecord.retryAfterMs);
  else
    retryAfterMs =
      parseRetryAfterMs(bodyRecord?.retryAfter ?? headerValue(headers, "retry-after")) ??
      retryAfterFromText(text);
  const effectiveCode = code === "unknown" && quotaExhausted(quota) ? "quota_exhausted" : code;
  return {
    code: effectiveCode,
    retryable: effectiveCode === "rate_limited" || effectiveCode === "disconnected",
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(quota ? { quota } : {}),
    lane: quota?.lane || asNonEmptyString(bodyRecord?.lane) || lane,
    message: SAFE_ERROR_MESSAGES[effectiveCode],
  };
}

export const parseChatgptFileError = classifyChatgptFileError;
export const parseChatgptFileRejection = classifyChatgptFileError;
export const sanitizeChatgptFileError = (error: unknown): ChatgptFileError =>
  errorFromClassification(classifyChatgptFileError(error));

export const __test__ = {
  MIME_BY_EXTENSION,
  quotaExhausted,
  associationMatches,
};
