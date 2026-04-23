import { mkdtemp, readFile, writeFile, stat, rm, truncate } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveBrowserAttachments } from "../../src/browser/attachmentResolver.js";

describe("resolveBrowserAttachments", () => {
  test("resolves files without applying the inline 1MB text cap", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-attachment-resolver-large-"));
    try {
      const largePath = path.join(dir, "large.txt");
      await writeFile(largePath, "x".repeat(1_200_000), "utf8");

      const attachments = await resolveBrowserAttachments(["large.txt"], { cwd: dir });

      expect(attachments).toEqual([
        expect.objectContaining({
          path: largePath,
          displayPath: "large.txt",
          sizeBytes: 1_200_000,
        }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("bundles more than twenty resolved files into one zip attachment", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-attachment-resolver-zip-"));
    try {
      for (let i = 1; i <= 21; i += 1) {
        await writeFile(path.join(dir, `file-${i}.txt`), `token-${i}\n`, "utf8");
      }

      const attachments = await resolveBrowserAttachments(["*.txt"], { cwd: dir });

      expect(attachments).toHaveLength(1);
      expect(path.basename(attachments[0]?.path ?? "")).toBe("attachments-bundle.zip");
      expect(attachments[0]?.displayPath).toBe(attachments[0]?.path);
      const bundleStat = await stat(attachments[0]?.path ?? "");
      expect(bundleStat.size).toBeGreaterThan(0);
      const zipBytes = await readFile(attachments[0]?.path ?? "");
      expect(zipBytes.subarray(0, 4).toString("binary")).toBe("PK\u0003\u0004");
      expect(zipBytes.includes(Buffer.from("file-1.txt"))).toBe(true);
      expect(zipBytes.includes(Buffer.from("file-21.txt"))).toBe(true);
      expect(zipBytes.includes(Buffer.from("token-21"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps up to twenty image attachments as first-class files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-attachment-resolver-images-"));
    try {
      for (let i = 1; i <= 12; i += 1) {
        await writeFile(path.join(dir, `image-${i}.svg`), `<svg>${i}</svg>`, "utf8");
      }

      const attachments = await resolveBrowserAttachments(["*.svg"], { cwd: dir });

      expect(attachments).toHaveLength(12);
      expect(attachments.every((attachment) => attachment.path.endsWith(".svg"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects image batches over the observed ChatGPT browser count limit", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-attachment-resolver-image-limit-"));
    try {
      for (let i = 1; i <= 21; i += 1) {
        await writeFile(path.join(dir, `image-${i}.svg`), `<svg>${i}</svg>`, "utf8");
      }

      await expect(resolveBrowserAttachments(["*.svg"], { cwd: dir })).rejects.toThrow(
        /image attachments exceed/i,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("bundles non-images while preserving image attachments when mixed over ten", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-attachment-resolver-mixed-"));
    try {
      for (let i = 1; i <= 19; i += 1) {
        await writeFile(path.join(dir, `image-${i}.svg`), `<svg>${i}</svg>`, "utf8");
      }
      for (let i = 1; i <= 5; i += 1) {
        await writeFile(path.join(dir, `note-${i}.txt`), `note-${i}`, "utf8");
      }

      const attachments = await resolveBrowserAttachments(["*"], { cwd: dir });

      expect(attachments).toHaveLength(20);
      expect(attachments.filter((attachment) => attachment.path.endsWith(".svg"))).toHaveLength(19);
      expect(path.basename(attachments.at(-1)?.path ?? "")).toBe("attachments-bundle.zip");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects mixed overflow when images leave no slot for a bundle", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-attachment-resolver-no-slot-"));
    try {
      for (let i = 1; i <= 20; i += 1) {
        await writeFile(path.join(dir, `image-${i}.svg`), `<svg>${i}</svg>`, "utf8");
      }
      await writeFile(path.join(dir, "note.txt"), "note", "utf8");

      await expect(resolveBrowserAttachments(["*"], { cwd: dir })).rejects.toThrow(
        /after bundling/i,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects aggregate attachment plans over the ChatGPT browser cap", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-attachment-resolver-cap-"));
    try {
      const hugePath = path.join(dir, "huge.bin");
      await writeFile(hugePath, "");
      await truncate(hugePath, 513 * 1024 * 1024);

      await expect(resolveBrowserAttachments(["huge.bin"], { cwd: dir })).rejects.toThrow(
        /aggregate limit/i,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
