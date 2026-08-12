import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type http from "node:http";
import path from "node:path";
import { mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import type { BrowserAttachment } from "../browser/types.js";
import { computeFileSha256 } from "../browser/artifacts.js";
import type { RemoteAttachmentPayload, RemoteRunPayload } from "./types.js";

export const REMOTE_RUN_PROTOCOL_VERSION = 2;
export const REMOTE_RUN_CONTENT_TYPE = "application/vnd.oracle.run+framed; version=2";
export const MAX_REMOTE_RUN_MANIFEST_BYTES = 1024 * 1024;
export const MAX_REMOTE_RUN_ATTACHMENT_BYTES = 512 * 1024 * 1024;
export const MAX_REMOTE_RUN_TOTAL_ATTACHMENT_BYTES = 512 * 1024 * 1024;
export const MAX_REMOTE_RUN_ATTACHMENTS = 20;
export const MAX_REMOTE_RUN_REQUEST_BYTES =
  MAX_REMOTE_RUN_TOTAL_ATTACHMENT_BYTES + MAX_REMOTE_RUN_MANIFEST_BYTES + 64;

const MAGIC = Buffer.from("ORACLE-RUN/2\n", "ascii");
const SHA256_RE = /^[a-f0-9]{64}$/;

export interface RemoteRunAttachmentSource {
  path: string;
  sizeBytes: number;
}

export interface PreparedRemoteRunRequest {
  payload: RemoteRunPayload;
  sources: RemoteRunAttachmentSource[];
  manifest: Buffer;
  prefix: Buffer;
  contentLength: number;
}

export interface ReceivedRemoteRunRequest {
  payload: RemoteRunPayload;
  attachments: BrowserAttachment[];
  fallbackAttachments: BrowserAttachment[];
  manifestPath: string;
}

export async function prepareRemoteRunRequest(params: {
  payload: Omit<RemoteRunPayload, "attachments" | "fallbackSubmission"> & {
    attachments?: BrowserAttachment[];
    fallbackSubmission?: {
      prompt: string;
      attachments?: BrowserAttachment[];
    };
  };
}): Promise<PreparedRemoteRunRequest> {
  const primaryAttachments = params.payload.attachments ?? [];
  const fallbackAttachments = params.payload.fallbackSubmission?.attachments ?? [];
  if (primaryAttachments.length + fallbackAttachments.length > MAX_REMOTE_RUN_ATTACHMENTS) {
    throw new Error(`Remote runs accept at most ${MAX_REMOTE_RUN_ATTACHMENTS} attachments.`);
  }
  const primary = await prepareAttachments(primaryAttachments);
  const fallback = await prepareAttachments(fallbackAttachments);
  const payload: RemoteRunPayload = {
    prompt: params.payload.prompt,
    attachments: primary.metadata,
    fallbackSubmission: params.payload.fallbackSubmission
      ? {
          prompt: params.payload.fallbackSubmission.prompt,
          attachments: fallback.metadata,
        }
      : undefined,
    browserConfig: params.payload.browserConfig,
    options: params.payload.options,
  };
  validateRemoteRunPayload(payload);
  const manifest = Buffer.from(JSON.stringify(payload), "utf8");
  if (manifest.length > MAX_REMOTE_RUN_MANIFEST_BYTES) {
    throw new Error(`Remote run manifest exceeds ${MAX_REMOTE_RUN_MANIFEST_BYTES} bytes.`);
  }
  const sizePrefix = Buffer.allocUnsafe(4);
  sizePrefix.writeUInt32BE(manifest.length);
  const prefix = Buffer.concat([MAGIC, sizePrefix, manifest]);
  const sources = [...primary.sources, ...fallback.sources];
  const contentLength =
    prefix.length + sources.reduce((total, source) => total + source.sizeBytes, 0);
  if (contentLength > MAX_REMOTE_RUN_REQUEST_BYTES) {
    throw new Error(`Remote run request exceeds ${MAX_REMOTE_RUN_REQUEST_BYTES} bytes.`);
  }
  return { payload, sources, manifest, prefix, contentLength };
}

export async function writePreparedRemoteRunRequest(
  request: http.ClientRequest,
  prepared: PreparedRemoteRunRequest,
): Promise<void> {
  await writeWithBackpressure(request, prepared.prefix);
  for (const source of prepared.sources) {
    let sent = 0;
    for await (const chunk of createReadStream(source.path)) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      sent += bytes.length;
      if (sent > source.sizeBytes) {
        throw new Error(`Attachment changed while streaming: ${source.path}`);
      }
      await writeWithBackpressure(request, bytes);
    }
    if (sent !== source.sizeBytes) {
      throw new Error(`Attachment changed while streaming: ${source.path}`);
    }
  }
  request.end();
}

export async function receiveRemoteRunRequest(
  request: http.IncomingMessage,
  runDir: string,
): Promise<ReceivedRemoteRunRequest> {
  try {
    const contentLength = assertRequestHeaders(request);
    const reader = new BoundedRequestReader(request, MAX_REMOTE_RUN_REQUEST_BYTES, contentLength);
    const magic = await reader.readExactly(MAGIC.length);
    if (!magic.equals(MAGIC)) {
      throw new Error("Unsupported remote run upload protocol.");
    }
    const manifestLength = (await reader.readExactly(4)).readUInt32BE(0);
    if (manifestLength <= 0 || manifestLength > MAX_REMOTE_RUN_MANIFEST_BYTES) {
      throw new Error("Invalid remote run manifest length.");
    }
    const manifestBytes = await reader.readExactly(manifestLength);
    let payload: RemoteRunPayload;
    try {
      payload = JSON.parse(manifestBytes.toString("utf8")) as RemoteRunPayload;
    } catch {
      throw new Error("Invalid remote run manifest JSON.");
    }
    validateRemoteRunPayload(payload);
    const declaredAttachmentBytes = [
      ...payload.attachments,
      ...(payload.fallbackSubmission?.attachments ?? []),
    ].reduce((total, attachment) => total + attachment.sizeBytes, 0);
    const expectedLength = MAGIC.length + 4 + manifestLength + declaredAttachmentBytes;
    if (contentLength !== expectedLength) {
      throw new Error(
        `Remote run Content-Length mismatch (${contentLength} != ${expectedLength}).`,
      );
    }

    const attachmentDir = path.join(runDir, "attachments");
    const fallbackDir = path.join(runDir, "fallback-attachments");
    await mkdir(attachmentDir, { recursive: true });
    if (payload.fallbackSubmission) {
      await mkdir(fallbackDir, { recursive: true });
    }

    const attachments = await receiveAttachments(reader, payload.attachments, attachmentDir);
    const fallbackAttachments = await receiveAttachments(
      reader,
      payload.fallbackSubmission?.attachments ?? [],
      fallbackDir,
    );
    await reader.assertEnd();
    const manifestPath = await publishManifest(runDir, manifestBytes);
    return { payload, attachments, fallbackAttachments, manifestPath };
  } catch (error) {
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function assertRequestHeaders(request: http.IncomingMessage): number {
  const contentType = String(request.headers["content-type"] ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (contentType !== REMOTE_RUN_CONTENT_TYPE) {
    throw new Error("Unsupported remote run content type.");
  }
  const rawLength = request.headers["content-length"];
  if (typeof rawLength !== "string" || !/^\d+$/.test(rawLength)) {
    throw new Error("Remote run requests require Content-Length.");
  }
  const contentLength = Number(rawLength);
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength < MAGIC.length + 4 + 1 ||
    contentLength > MAX_REMOTE_RUN_REQUEST_BYTES
  ) {
    throw new Error("Remote run Content-Length exceeds the configured limit.");
  }
  return contentLength;
}

async function prepareAttachments(attachments: BrowserAttachment[]): Promise<{
  metadata: RemoteAttachmentPayload[];
  sources: RemoteRunAttachmentSource[];
}> {
  if (attachments.length > MAX_REMOTE_RUN_ATTACHMENTS) {
    throw new Error(`Remote runs accept at most ${MAX_REMOTE_RUN_ATTACHMENTS} attachments.`);
  }
  const metadata: RemoteAttachmentPayload[] = [];
  const sources: RemoteRunAttachmentSource[] = [];
  let totalBytes = 0;
  for (const attachment of attachments) {
    const sizeBytes = await readStableAttachmentSize(attachment.path);
    validateAttachmentSize(sizeBytes);
    totalBytes += sizeBytes;
    if (totalBytes > MAX_REMOTE_RUN_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(`Remote attachments exceed ${MAX_REMOTE_RUN_TOTAL_ATTACHMENT_BYTES} bytes.`);
    }
    const sha256 = await computeFileSha256(attachment.path);
    metadata.push({
      fileName: path.basename(attachment.path),
      displayPath: attachment.displayPath,
      sizeBytes,
      sha256,
    });
    sources.push({ path: attachment.path, sizeBytes });
  }
  return { metadata, sources };
}

async function readStableAttachmentSize(filePath: string): Promise<number> {
  const file = await open(filePath, "r");
  try {
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw new Error(`Remote attachment is not a regular file: ${filePath}`);
    }
    return stats.size;
  } finally {
    await file.close();
  }
}

function validateRemoteRunPayload(payload: RemoteRunPayload): void {
  if (!payload || typeof payload !== "object") {
    throw new Error("Remote run manifest must be an object.");
  }
  if (typeof payload.prompt !== "string" || payload.prompt.length === 0) {
    throw new Error("Remote run prompt is required.");
  }
  if (!payload.browserConfig || typeof payload.browserConfig !== "object") {
    throw new Error("Remote run browserConfig is required.");
  }
  if (!payload.options || typeof payload.options !== "object") {
    throw new Error("Remote run options are required.");
  }
  validateAttachmentMetadata(payload.attachments, "attachments");
  if (payload.fallbackSubmission !== undefined) {
    if (
      !payload.fallbackSubmission ||
      typeof payload.fallbackSubmission !== "object" ||
      typeof payload.fallbackSubmission.prompt !== "string" ||
      payload.fallbackSubmission.prompt.length === 0
    ) {
      throw new Error("Invalid fallback submission.");
    }
    validateAttachmentMetadata(payload.fallbackSubmission.attachments, "fallback attachments");
  }
  const all = [...payload.attachments, ...(payload.fallbackSubmission?.attachments ?? [])];
  if (all.length > MAX_REMOTE_RUN_ATTACHMENTS) {
    throw new Error(`Remote runs accept at most ${MAX_REMOTE_RUN_ATTACHMENTS} attachments.`);
  }
  const total = all.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
  if (total > MAX_REMOTE_RUN_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(`Remote attachments exceed ${MAX_REMOTE_RUN_TOTAL_ATTACHMENT_BYTES} bytes.`);
  }
}

function validateAttachmentMetadata(attachments: RemoteAttachmentPayload[], label: string): void {
  if (!Array.isArray(attachments)) {
    throw new Error(`Remote run ${label} must be an array.`);
  }
  for (const attachment of attachments) {
    if (
      !attachment ||
      typeof attachment !== "object" ||
      typeof attachment.fileName !== "string" ||
      attachment.fileName.length === 0 ||
      typeof attachment.displayPath !== "string" ||
      !Number.isSafeInteger(attachment.sizeBytes) ||
      !SHA256_RE.test(attachment.sha256)
    ) {
      throw new Error(`Invalid remote run ${label} metadata.`);
    }
    validateAttachmentSize(attachment.sizeBytes);
  }
}

function validateAttachmentSize(sizeBytes: number): void {
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    sizeBytes > MAX_REMOTE_RUN_ATTACHMENT_BYTES
  ) {
    throw new Error(
      `Remote attachment size must be between 0 and ${MAX_REMOTE_RUN_ATTACHMENT_BYTES} bytes.`,
    );
  }
}

async function receiveAttachments(
  reader: BoundedRequestReader,
  metadata: RemoteAttachmentPayload[],
  directory: string,
): Promise<BrowserAttachment[]> {
  const attachments: BrowserAttachment[] = [];
  for (const [index, attachment] of metadata.entries()) {
    const safeName = sanitizeName(attachment.fileName || `attachment-${index + 1}`);
    const filePath = path.join(directory, `${String(index + 1).padStart(3, "0")}-${safeName}`);
    const tempPath = `${filePath}.part`;
    const file = await open(tempPath, "wx");
    const hash = createHash("sha256");
    try {
      await reader.pipeExactly(attachment.sizeBytes, async (chunk) => {
        hash.update(chunk);
        await writeAll(file, chunk);
      });
      await file.sync();
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await file.close().catch(() => undefined);
    }
    const actualHash = hash.digest("hex");
    if (actualHash !== attachment.sha256) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw new Error(`Remote attachment hash mismatch for ${attachment.fileName}.`);
    }
    await rename(tempPath, filePath);
    attachments.push({
      path: filePath,
      displayPath: attachment.displayPath,
      sizeBytes: attachment.sizeBytes,
    });
  }
  return attachments;
}

async function publishManifest(runDir: string, manifest: Buffer): Promise<string> {
  const tempPath = path.join(runDir, ".manifest.part");
  const manifestPath = path.join(runDir, "manifest.json");
  const file = await open(tempPath, "wx");
  try {
    await writeAll(file, manifest);
    await file.sync();
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await file.close().catch(() => undefined);
  }
  await rename(tempPath, manifestPath);
  return manifestPath;
}

async function writeAll(file: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, null);
    if (bytesWritten <= 0) {
      throw new Error("Remote attachment spool stopped making progress.");
    }
    offset += bytesWritten;
  }
}

function sanitizeName(raw: string): string {
  const sanitized = path.basename(raw).replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized || "attachment.bin";
}

async function writeWithBackpressure(request: http.ClientRequest, chunk: Buffer): Promise<void> {
  if (request.destroyed) {
    throw new Error("Remote run request closed while streaming attachments.");
  }
  if (request.write(chunk)) return;
  let resolveGate!: () => void;
  let rejectGate!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = reject;
  });
  const onDrain = () => {
    cleanup();
    resolveGate();
  };
  const onError = (error: Error) => {
    cleanup();
    rejectGate(error);
  };
  const cleanup = () => {
    request.off("drain", onDrain);
    request.off("error", onError);
  };
  request.once("drain", onDrain);
  request.once("error", onError);
  await promise;
}

class BoundedRequestReader {
  private readonly iterator: AsyncIterator<Buffer<ArrayBufferLike> | string>;
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private consumed = 0;
  private ended = false;

  constructor(
    request: http.IncomingMessage,
    private readonly maxBytes: number,
    private readonly declaredLength: number,
  ) {
    this.iterator = request[Symbol.asyncIterator]();
  }

  async readExactly(length: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    await this.pipeExactly(length, async (chunk) => {
      chunks.push(chunk);
    });
    return Buffer.concat(chunks, length);
  }

  async pipeExactly(length: number, consume: (chunk: Buffer) => Promise<void>): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      const chunk = await this.take(Math.min(remaining, 64 * 1024));
      if (chunk.length === 0) {
        throw new Error("Remote run request ended early.");
      }
      remaining -= chunk.length;
      await consume(chunk);
    }
  }

  async assertEnd(): Promise<void> {
    if (this.buffered.length > 0) {
      throw new Error("Remote run request contains trailing bytes.");
    }
    if (this.consumed !== this.declaredLength) {
      throw new Error(
        `Remote run Content-Length mismatch (${this.declaredLength} != ${this.consumed}).`,
      );
    }
    const next = await this.iterator.next();
    if (!next.done) {
      throw new Error("Remote run request contains trailing bytes.");
    }
    this.ended = true;
  }

  private async take(maxLength: number): Promise<Buffer> {
    while (this.buffered.length === 0 && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      const chunk = typeof next.value === "string" ? Buffer.from(next.value) : next.value;
      this.consumed += chunk.length;
      if (this.consumed > this.declaredLength) {
        throw new Error("Remote run Content-Length mismatch.");
      }
      if (this.consumed > this.maxBytes) {
        throw new Error("Remote run request exceeded the configured byte limit.");
      }
      this.buffered = chunk;
    }
    if (this.buffered.length === 0) return Buffer.alloc(0);
    const length = Math.min(maxLength, this.buffered.length);
    const result = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return result;
  }
}

export const __test__ = {
  MAGIC,
  validateRemoteRunPayload,
  sanitizeName,
};
