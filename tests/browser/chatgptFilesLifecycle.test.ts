import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  classifyChatgptFileError,
  downloadChatgptFile,
  fingerprintChatgptFile,
  matchChatgptFileAssociations,
  parseRetryAfterMs,
  preflightChatgptFile,
  uploadChatgptFile,
  verifyChatgptFileAssociations,
} from "../../src/browser/chatgpt/files.js";

describe("ChatGPT file lifecycle", () => {
  async function fixture(
    name: string,
    content: string | Uint8Array,
  ): Promise<{ dir: string; filePath: string }> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-"));
    const filePath = path.join(dir, name);
    await writeFile(filePath, content);
    return { dir, filePath };
  }

  test("preflight checks supported type and exact observed size boundary", async () => {
    const { dir, filePath } = await fixture("notes.txt", "hello");
    try {
      const result = await preflightChatgptFile(filePath, {
        supportedExtensions: [".txt"],
        supportedMimeTypes: ["text/plain"],
        maxBytes: 5,
      });
      expect(result.status).toBe("accepted");
      expect(result.fingerprint.sizeBytes).toBe(5);
      expect(Object.isFrozen(result.fingerprint)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports unsupported type and an observed oversize file", async () => {
    const { dir, filePath } = await fixture("notes.txt", "hello!");
    try {
      await expect(
        preflightChatgptFile(filePath, { supportedExtensions: [".pdf"] }),
      ).resolves.toMatchObject({
        status: "unsupported",
        evidence: { extension: ".txt" },
      });
      await expect(preflightChatgptFile(filePath, { maxBytes: 5 })).resolves.toMatchObject({
        status: "too_large",
        evidence: { maxBytes: 5 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not invent a quota when no quota was observed", async () => {
    const { dir, filePath } = await fixture("unknown.txt", "x");
    try {
      const result = await preflightChatgptFile(filePath);
      expect(result.status).toBe("accepted");
      expect(result.evidence.quota).toBeUndefined();
      expect(result.evidence.maxBytes).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("isolates quota and rate-limit evidence by lane and preserves retryAfter", async () => {
    const { dir, filePath } = await fixture("quota.txt", "x");
    try {
      const exhausted = await preflightChatgptFile(filePath, {
        lane: "file_upload",
        quota: { lane: "file_upload", used: 3, limit: 3, source: "response", observedAt: "now" },
      });
      expect(exhausted.status).toBe("quota_exhausted");
      const isolated = await preflightChatgptFile(filePath, {
        lane: "file_upload",
        quota: { lane: "image_upload", used: 3, limit: 3, source: "response", observedAt: "now" },
        rateLimit: {
          lane: "image_upload",
          retryAfterMs: 1_250,
          source: "header",
          observedAt: "now",
        },
      });
      expect(isolated.status).toBe("accepted");
      expect(isolated.evidence.quota).toBeUndefined();
      expect(isolated.evidence.rateLimit).toBeUndefined();
      const limited = await preflightChatgptFile(filePath, {
        lane: "image_upload",
        rateLimit: {
          lane: "image_upload",
          retryAfterMs: 1_250,
          source: "header",
          observedAt: "now",
        },
      });
      expect(limited.status).toBe("rate_limited");
      expect(limited.retryAfterMs).toBe(1_250);
      expect(limited.evidence.rateLimit?.lane).toBe("image_upload");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("streams progress as bytes without base64 and reaches ready", async () => {
    const { dir, filePath } = await fixture("stream.txt", "streamed bytes");
    try {
      const progress: string[] = [];
      const result = await uploadChatgptFile({
        file: filePath,
        onProgress: (item) => progress.push(item.state),
        transport: async (stream) => {
          for await (const chunk of stream) {
            expect(typeof chunk).toBe("object");
            expect(chunk).toBeInstanceOf(Uint8Array);
            expect(typeof chunk).not.toBe("string");
          }
          return { fileId: "file-1" };
        },
      });
      expect(result.state).toBe("ready");
      expect(result.fileId).toBe("file-1");
      expect(progress).toContain("staged");
      expect(progress).toContain("streaming");
      expect(progress).toContain("ready");
      expect(result.progress.at(-1)?.percent).toBe(100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("associates multiple duplicate names by hash and size, independent of order", async () => {
    const first = await fixture("same.txt", "first");
    const second = await fixture("same.txt", "second");
    try {
      const [firstFingerprint, secondFingerprint] = await Promise.all([
        fingerprintChatgptFile(first.filePath),
        fingerprintChatgptFile(second.filePath),
      ]);
      const expected = [
        {
          fingerprint: firstFingerprint,
          conversationId: "c1",
          turnId: "t1",
          messageId: "m1",
          fileId: "f1",
        },
        {
          fingerprint: secondFingerprint,
          conversationId: "c1",
          turnId: "t1",
          messageId: "m1",
          fileId: "f2",
        },
      ];
      const observed = [expected[1], expected[0]].map(({ fingerprint, fileId, ...ids }) => ({
        ...ids,
        fileId,
        name: fingerprint.displayName,
        sizeBytes: fingerprint.sizeBytes,
        sha256: fingerprint.sha256,
      }));
      expect(matchChatgptFileAssociations(expected, observed).matched).toBe(true);
      expect(verifyChatgptFileAssociations(expected, observed).map((item) => item.fileId)).toEqual([
        "f1",
        "f2",
      ]);
      expect(matchChatgptFileAssociations(expected, observed.slice(0, 1)).matched).toBe(false);
    } finally {
      await Promise.all([
        rm(first.dir, { recursive: true, force: true }),
        rm(second.dir, { recursive: true, force: true }),
      ]);
    }
  });

  test("verifies exact post-send turn/message association and sanitizes disconnects", async () => {
    const { dir, filePath } = await fixture("send.txt", "payload");
    try {
      const result = await uploadChatgptFile({
        file: filePath,
        transport: async (stream) => {
          for await (const _chunk of stream) {
            // Consume the stream so progress remains truthful.
          }
          return { fileId: "f-send" };
        },
        submit: async () => ({ conversationId: "c1", turnId: "t1", messageId: "m1" }),
        associate: async ({ fingerprint, conversationId, turnId, messageId, fileId }) => ({
          conversationId,
          turnId,
          messageId,
          fileId,
          name: fingerprint.displayName,
          sizeBytes: fingerprint.sizeBytes,
          sha256: fingerprint.sha256,
        }),
      });
      expect(result.state).toBe("associated");
      expect(result.association?.conversationId).toBe("c1");
      expect(result.association?.messageId).toBe("m1");

      const error = classifyChatgptFileError({
        status: 503,
        message: `connection lost at ${filePath}`,
      });
      expect(error.code).toBe("disconnected");
      expect(error.retryable).toBe(true);
      expect(error.message).not.toContain(filePath);
      expect(parseRetryAfterMs("2 seconds")).toBeUndefined();
      expect(
        classifyChatgptFileError({ status: 429, body: "retry-after 2 seconds", retryAfterMs: 900 })
          .retryAfterMs,
      ).toBe(900);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("downloads and hashes bytes returned by the semantic transport", async () => {
    const { dir, filePath } = await fixture("download.txt", "downloaded");
    try {
      const fingerprint = await fingerprintChatgptFile(filePath);
      const destinationPath = path.join(dir, "out.txt");
      const result = await downloadChatgptFile({
        fileId: "f-download",
        destinationPath,
        policy: { maxDownloadBytes: 1024, approvedOutputRoot: dir },
        get: async () => ({
          fileId: "f-download",
          name: "download.txt",
          sizeBytes: fingerprint.sizeBytes,
          sha256: fingerprint.sha256,
        }),
        download: async () => new Uint8Array(Buffer.from("downloaded")),
      });
      expect(result.sizeBytes).toBe(fingerprint.sizeBytes);
      expect(result.sha256).toBe(fingerprint.sha256);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("confines destinations and refuses traversal, symlink parents/finals, and existing files", async () => {
    const { dir } = await fixture("source.txt", "source");
    const policy = { maxDownloadBytes: 1024, approvedOutputRoot: dir };
    const download = (destinationPath: string) =>
      downloadChatgptFile({
        fileId: "f-safe",
        destinationPath,
        policy,
        download: async () => new Uint8Array(Buffer.from("payload")),
      });
    const outsidePath = path.join(path.dirname(dir), "escape.txt");
    const realParent = path.join(dir, "real-parent");
    const linkedParent = path.join(dir, "linked-parent");
    const realFinal = path.join(dir, "real-final.txt");
    const linkedFinal = path.join(dir, "linked-final.txt");
    try {
      await writeFile(realFinal, "keep");
      await symlink(realParent, linkedParent);
      await symlink(realFinal, linkedFinal);
      await expect(download(path.join(dir, "..", "escape.txt"))).rejects.toThrow();
      await expect(download(path.join(dir, "linked-parent", "file.txt"))).rejects.toThrow();
      await expect(download(linkedFinal)).rejects.toThrow();
      await expect(download(path.join(dir, "real-final.txt"))).rejects.toThrow();
      await expect(readFile(realFinal, "utf8")).resolves.toBe("keep");
      await expect(readFile(outsidePath, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outsidePath, { force: true });
    }
  });

  test("streams chunks into an exclusive temporary file and removes it on overflow", async () => {
    const { dir } = await fixture("source.txt", "");
    const destinationPath = path.join(dir, "nested", "out.txt");
    const chunks = [Buffer.from("abc"), Buffer.from("def"), Buffer.from("ghi")];
    let yielded = 0;
    try {
      await expect(
        downloadChatgptFile({
          fileId: "f-overflow",
          destinationPath,
          policy: { maxDownloadBytes: 5, approvedOutputRoot: dir },
          download: async () =>
            (async function* () {
              for (const chunk of chunks) {
                yielded += 1;
                yield chunk;
              }
            })(),
        }),
      ).rejects.toThrow();
      expect(yielded).toBe(2);
      await expect(readFile(destinationPath)).rejects.toThrow();
      await expect(readdir(path.dirname(destinationPath))).resolves.toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns MIME, hash, size, and ChatGPT provenance for multi-chunk success", async () => {
    const { dir } = await fixture("source.txt", "");
    const destinationPath = path.join(dir, "nested", "out.txt");
    const chunks = [new Uint8Array([104, 101]), new Uint8Array([108]), new Uint8Array([108, 111])];
    try {
      const result = await downloadChatgptFile({
        fileId: "f-success",
        destinationPath,
        policy: { maxDownloadBytes: 1024, approvedOutputRoot: dir },
        get: async () => ({ fileId: "f-success", name: "result.txt", sizeBytes: 5 }),
        download: async () =>
          (async function* () {
            for (const chunk of chunks) yield chunk;
          })(),
      });
      expect(result).toMatchObject({
        fileId: "f-success",
        name: "result.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        provenance: { source: "chatgpt-file", fileId: "f-success" },
      });
      await expect(readFile(destinationPath, "utf8")).resolves.toBe("hello");
      expect(await readdir(path.dirname(destinationPath))).toEqual(["out.txt"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
