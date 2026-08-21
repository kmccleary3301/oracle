import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import {
  __test__,
  MAX_REMOTE_RUN_ATTACHMENTS,
  prepareRemoteRunRequest,
  receiveRemoteRunRequest,
  REMOTE_RUN_CONTENT_TYPE,
  type PreparedRemoteRunRequest,
} from "../../src/remote/runProtocol.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-run-protocol-test-"));
  tempDirs.push(directory);
  return directory;
}

describe("remote run streaming protocol", () => {
  test("keeps attachment bytes outside the JSON manifest", async () => {
    const directory = await makeTempDir();
    const attachmentPath = path.join(directory, "large.bin");
    await writeFile(attachmentPath, "");
    await truncate(attachmentPath, 8 * 1024 * 1024);

    const prepared = await prepareRemoteRunRequest({
      payload: {
        prompt: "stream this file",
        attachments: [
          {
            path: attachmentPath,
            displayPath: "large.bin",
            sizeBytes: 8 * 1024 * 1024,
          },
        ],
        browserConfig: {},
        options: {},
      },
    });

    expect(REMOTE_RUN_CONTENT_TYPE).toContain("framed");
    expect(prepared.manifest.length).toBeLessThan(4 * 1024);
    expect(prepared.contentLength).toBe(prepared.prefix.length + 8 * 1024 * 1024);
    expect(prepared.payload.attachments[0]).toMatchObject({
      fileName: "large.bin",
      displayPath: "large.bin",
      sizeBytes: 8 * 1024 * 1024,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(prepared.payload)).not.toContain("contentBase64");
  });

  test("uses actual file size rather than caller metadata", async () => {
    const directory = await makeTempDir();
    const attachmentPath = path.join(directory, "note.txt");
    await writeFile(attachmentPath, "hello", "utf8");

    const prepared = await prepareRemoteRunRequest({
      payload: {
        prompt: "read",
        attachments: [{ path: attachmentPath, displayPath: "note.txt", sizeBytes: 999_999 }],
        browserConfig: {},
        options: {},
      },
    });

    expect(prepared.payload.attachments[0]?.sizeBytes).toBe(5);
  });

  test("rejects aggregate attachment count before upload", async () => {
    const directory = await makeTempDir();
    const attachmentPath = path.join(directory, "empty.txt");
    await writeFile(attachmentPath, "", "utf8");
    const attachments = Array.from({ length: MAX_REMOTE_RUN_ATTACHMENTS + 1 }, (_, index) => ({
      path: attachmentPath,
      displayPath: `empty-${index}.txt`,
      sizeBytes: 0,
    }));

    await expect(
      prepareRemoteRunRequest({
        payload: {
          prompt: "too many",
          attachments,
          browserConfig: {},
          options: {},
        },
      }),
    ).rejects.toThrow(`at most ${MAX_REMOTE_RUN_ATTACHMENTS}`);
  });

  test("rejects untrusted attachment metadata", () => {
    expect(() =>
      __test__.validateRemoteRunPayload({
        prompt: "invalid",
        attachments: [
          {
            fileName: "note.txt",
            displayPath: "note.txt",
            sizeBytes: 5,
            sha256: "not-a-hash",
          },
        ],
        browserConfig: {},
        options: {},
      }),
    ).toThrow("metadata");
  });

  test("spools multiple files in wire order and atomically publishes the manifest", async () => {
    const sourceDir = await makeTempDir();
    const firstPath = path.join(sourceDir, "first.txt");
    const secondPath = path.join(sourceDir, "second.txt");
    await writeFile(firstPath, "first", "utf8");
    await writeFile(secondPath, "second", "utf8");
    const prepared = await prepareRemoteRunRequest({
      payload: {
        prompt: "ordered",
        attachments: [
          { path: firstPath, displayPath: "first.txt" },
          { path: secondPath, displayPath: "second.txt" },
        ],
        browserConfig: {},
        options: {},
      },
    });
    const body = await frameWithSourceBytes(prepared);
    const runDir = await makeTempDir();
    const received = await receiveRemoteRunRequest(fakeIncomingRequest(body), runDir);

    expect(await readFile(received.attachments[0]!.path, "utf8")).toBe("first");
    expect(await readFile(received.attachments[1]!.path, "utf8")).toBe("second");
    expect(await readFile(received.manifestPath)).toEqual(prepared.manifest);
    expect(await readdir(runDir)).toEqual(expect.arrayContaining(["attachments", "manifest.json"]));
    expect(await readdir(path.join(runDir, "attachments"))).toEqual([
      "001-first.txt",
      "002-second.txt",
    ]);
  });

  test("rejects a declared-size mismatch before spooling attachment bytes", async () => {
    const sourceDir = await makeTempDir();
    const attachmentPath = path.join(sourceDir, "declared.txt");
    await writeFile(attachmentPath, "declared", "utf8");
    const prepared = await prepareRemoteRunRequest({
      payload: {
        prompt: "declared size",
        attachments: [{ path: attachmentPath, displayPath: "declared.txt" }],
        browserConfig: {},
        options: {},
      },
    });
    const runDir = await makeTempDir();
    await expect(
      receiveRemoteRunRequest(
        fakeIncomingRequest(prepared.prefix, prepared.contentLength + 1),
        runDir,
      ),
    ).rejects.toThrow("Content-Length mismatch");
    await expect(readdir(runDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects truncation and removes incomplete spools", async () => {
    const sourceDir = await makeTempDir();
    const attachmentPath = path.join(sourceDir, "truncated.txt");
    await writeFile(attachmentPath, "truncate me", "utf8");
    const prepared = await prepareRemoteRunRequest({
      payload: {
        prompt: "truncated",
        attachments: [{ path: attachmentPath, displayPath: "truncated.txt" }],
        browserConfig: {},
        options: {},
      },
    });
    const body = await frameWithSourceBytes(prepared);
    const runDir = await makeTempDir();
    await expect(
      receiveRemoteRunRequest(
        fakeIncomingRequest(body.subarray(0, body.length - 1), prepared.contentLength),
        runDir,
      ),
    ).rejects.toThrow("ended early");
    await expect(readdir(runDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects hash mismatches and removes incomplete spools", async () => {
    const sourceDir = await makeTempDir();
    const attachmentPath = path.join(sourceDir, "hashed.txt");
    await writeFile(attachmentPath, "hash me", "utf8");
    const prepared = await prepareRemoteRunRequest({
      payload: {
        prompt: "hash mismatch",
        attachments: [{ path: attachmentPath, displayPath: "hashed.txt" }],
        browserConfig: {},
        options: {},
      },
    });
    const payload = JSON.parse(prepared.manifest.toString("utf8")) as {
      attachments: Array<{ sha256: string }>;
    };
    payload.attachments[0]!.sha256 = "0".repeat(64);
    const manifest = Buffer.from(JSON.stringify(payload), "utf8");
    const prefix = Buffer.allocUnsafe(__test__.MAGIC.length + 4 + manifest.length);
    __test__.MAGIC.copy(prefix);
    prefix.writeUInt32BE(manifest.length, __test__.MAGIC.length);
    manifest.copy(prefix, __test__.MAGIC.length + 4);
    const body = Buffer.concat([prefix, Buffer.from("hash me", "utf8")]);
    const runDir = await makeTempDir();

    await expect(receiveRemoteRunRequest(fakeIncomingRequest(body), runDir)).rejects.toThrow(
      "hash mismatch",
    );
    await expect(readdir(runDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function frameWithSourceBytes(prepared: PreparedRemoteRunRequest): Promise<Buffer> {
  const chunks = await Promise.all(prepared.sources.map((source) => readFile(source.path)));
  return Buffer.concat([prepared.prefix, ...chunks]);
}

function fakeIncomingRequest(body: Buffer, contentLength = body.length): http.IncomingMessage {
  return {
    headers: {
      "content-type": REMOTE_RUN_CONTENT_TYPE,
      "content-length": String(contentLength),
    },
    async *[Symbol.asyncIterator]() {
      for (let offset = 0; offset < body.length; offset += 32 * 1024) {
        yield body.subarray(offset, offset + 32 * 1024);
      }
    },
  } as unknown as http.IncomingMessage;
}
