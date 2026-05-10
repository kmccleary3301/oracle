import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { normalizeDurableJobFileInputs } from "@src/cli/durableJobFiles.ts";

describe("normalizeDurableJobFileInputs", () => {
  test("resolves durable job file inputs to absolute paths from the submit cwd", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-durable-files-"));
    try {
      const filePath = path.join(dir, "docs", "packet.md");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "packet", "utf8");

      const files = await normalizeDurableJobFileInputs(["docs/packet.md"], dir);

      expect(files).toEqual([{ originalPath: "docs/packet.md", resolvedPath: filePath }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects missing durable job file inputs before daemon submission", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-durable-files-missing-"));
    try {
      await expect(normalizeDurableJobFileInputs(["ghost.md"], dir)).rejects.toThrow(
        /Missing file or directory/i,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
