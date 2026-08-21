import { mkdtemp, open, readFile, readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, test } from "vitest";
import {
  registerChatgptFilesTools,
  type ChatgptFilesToolDependencies,
} from "../../src/mcp/tools/chatgptFiles.js";

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};
type ToolHandler = (input: unknown) => Promise<ToolResult>;

function downloadHandler(dependencies: ChatgptFilesToolDependencies = {}): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    registerTool: (_name: string, _definition: unknown, callback: ToolHandler) => {
      if (_name === "chatgpt_file_download") handler = callback;
    },
  } as unknown as McpServer;
  registerChatgptFilesTools(server, dependencies);
  if (!handler) throw new Error("chatgpt_file_download handler was not registered");
  return handler;
}

async function fixture(content: string | Uint8Array): Promise<{ dir: string; sourcePath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-mcp-chatgpt-file-"));
  const sourcePath = path.join(dir, "source.txt");
  await writeFile(sourcePath, content);
  return { dir, sourcePath };
}

describe("chatgpt_file_download MCP tool", () => {
  test("uses injected trusted policy for a successful download inside its root", async () => {
    const { dir, sourcePath } = await fixture("trusted payload");
    try {
      const handler = downloadHandler({
        policy: { approvedOutputRoot: dir, maxDownloadBytes: 1024 },
      });
      const destinationPath = path.join("nested", "result.txt");
      const result = await handler({ sourcePath, destinationPath, fileId: "file-trusted" });

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        operation: "file.download",
        fileId: "file-trusted",
        downloadedPath: path.join(dir, destinationPath),
      });
      await expect(readFile(path.join(dir, destinationPath), "utf8")).resolves.toBe(
        "trusted payload",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails closed when no trusted policy is injected", async () => {
    const { dir, sourcePath } = await fixture("payload");
    try {
      const result = await downloadHandler()({ sourcePath, destinationPath: "result.txt" });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not let callers override the trusted root or maximum size", async () => {
    const { dir, sourcePath } = await fixture("payload");
    const outside = await mkdtemp(path.join(os.tmpdir(), "oracle-mcp-chatgpt-outside-"));
    try {
      const handler = downloadHandler({ policy: { approvedOutputRoot: dir, maxDownloadBytes: 4 } });
      await expect(
        handler({ sourcePath, destinationPath: path.join(outside, "escape.txt") }),
      ).resolves.toMatchObject({
        isError: true,
      });
      await expect(
        handler({ sourcePath, destinationPath: "oversized.txt", maxDownloadBytes: 1024 }),
      ).resolves.toMatchObject({ isError: true });
      await expect(readdir(outside)).resolves.toEqual([]);
      await expect(readdir(dir)).resolves.toEqual(["source.txt"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("rejects source files reached through symlink parents or final components", async () => {
    const { dir, sourcePath } = await fixture("payload");
    const realParent = path.join(dir, "real-parent");
    const linkedParent = path.join(dir, "linked-parent");
    const linkedFinal = path.join(dir, "linked-final.txt");
    try {
      await mkdir(realParent);
      await writeFile(path.join(realParent, "nested.txt"), "payload");
      await symlink(realParent, linkedParent);
      await symlink(sourcePath, linkedFinal);
      const handler = downloadHandler({
        policy: { approvedOutputRoot: dir, maxDownloadBytes: 1024 },
      });

      await expect(
        handler({
          sourcePath: path.join(linkedParent, "nested.txt"),
          destinationPath: "parent.txt",
        }),
      ).resolves.toMatchObject({ isError: true });
      await expect(
        handler({ sourcePath: linkedFinal, destinationPath: "final.txt" }),
      ).resolves.toMatchObject({
        isError: true,
      });
      await expect(readdir(dir)).resolves.toEqual([
        "linked-final.txt",
        "linked-parent",
        "real-parent",
        "source.txt",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects a source mutation race and leaves no destination or temporary file", async () => {
    const content = Buffer.alloc(8 * 1024 * 1024, 97);
    const { dir, sourcePath } = await fixture(content);
    const sourceHandle = await open(sourcePath, "r+");
    let mutating = true;
    let nextByte = 97;
    const mutate = async (): Promise<void> => {
      while (mutating) {
        nextByte = nextByte === 97 ? 98 : 97;
        await sourceHandle.write(Buffer.from([nextByte]), 0, 1, 0);
      }
    };
    const mutation = mutate();
    try {
      const handler = downloadHandler({
        policy: { approvedOutputRoot: dir, maxDownloadBytes: content.byteLength + 1 },
      });
      const result = await handler({ sourcePath, destinationPath: "race.txt" });
      expect(result.isError).toBe(true);
      await expect(readFile(path.join(dir, "race.txt"))).rejects.toThrow();
      await expect(readdir(dir)).resolves.toEqual(["source.txt"]);
    } finally {
      mutating = false;
      await mutation;
      await sourceHandle.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
