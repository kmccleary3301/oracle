import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { MAX_REMOTE_RUN_ATTACHMENT_BYTES } from "../../src/remote/runProtocol.js";

const PROTOCOL_MODULE = new URL("../../src/remote/runProtocol.ts", import.meta.url).href;
// The child imports the protocol by URL so the probe exercises the same source module as Vitest.
const CHILD_SCRIPT = `
import { createHash } from "node:crypto";
import http from "node:http";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const protocol = await import(process.env.ORACLE_REMOTE_PROTOCOL_MODULE);
const sourcePath = process.env.ORACLE_REMOTE_SOURCE_PATH;
const expectedSize = Number(process.env.ORACLE_REMOTE_SOURCE_SIZE);
if (!sourcePath || !Number.isSafeInteger(expectedSize)) {
  throw new Error("Child protocol probe received invalid source metadata.");
}

let peakRss = process.memoryUsage().rss;
const baselineRss = peakRss;
const sampleRss = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};
// Real intervals are required here: the peak is sampled while actual socket and file I/O run.
const sampler = setInterval(sampleRss, 1);
sampler.unref();
let runDir;
let server;
let client;
try {
  runDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-memory-run-"));
  server = http.createServer((request, response) => {
    void (async () => {
      try {
        const received = await protocol.receiveRemoteRunRequest(request, runDir);
        sampleRss();
        const attachment = received.attachments[0];
        if (!attachment) throw new Error("Server did not receive an attachment.");
        const hash = createHash("sha256");
        let receivedSize = 0;
        for await (const chunk of createReadStream(attachment.path)) {
          hash.update(chunk);
          receivedSize += chunk.length;
          sampleRss();
        }
        sampleRss();
        const receivedStats = await stat(attachment.path);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          preparedHash: received.payload.attachments[0]?.sha256,
          receivedHash: hash.digest("hex"),
          receivedSize,
          spooledSize: receivedStats.size,
        }));
      } catch (error) {
        response.statusCode = 500;
        response.end(String(error));
      }
    })();
  });
  const listenGate = Promise.withResolvers();
  server.once("error", listenGate.reject);
  server.listen(0, "127.0.0.1", listenGate.resolve);
  await listenGate.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind.");

  const prepared = await protocol.prepareRemoteRunRequest({
    payload: {
      prompt: "stream a large attachment",
      attachments: [{ path: sourcePath, displayPath: "generated.bin" }],
      browserConfig: {},
      options: {},
    },
  });
  sampleRss();
  if (prepared.payload.attachments[0]?.sizeBytes !== expectedSize) {
    throw new Error("Prepared attachment size does not match the generated file.");
  }

  const responseGate = Promise.withResolvers();
  client = http.request({
    host: "127.0.0.1",
    port: address.port,
    path: "/run",
    method: "POST",
    headers: {
      "content-type": protocol.REMOTE_RUN_CONTENT_TYPE,
      "content-length": String(prepared.contentLength),
    },
  });
  client.once("error", responseGate.reject);
  client.once("response", (response) => {
    const chunks = [];
    response.setEncoding("utf8");
    response.on("data", (chunk) => chunks.push(chunk));
    response.on("end", () => responseGate.resolve({
      statusCode: response.statusCode ?? 0,
      body: chunks.join(""),
    }));
  });
  await protocol.writePreparedRemoteRunRequest(client, prepared);
  const response = await responseGate.promise;
  sampleRss();
  if (response.statusCode !== 200) throw new Error(String(response.body));
  const result = JSON.parse(response.body);
  process.stdout.write(JSON.stringify({
    ...result,
    peakDelta: Math.max(0, peakRss - baselineRss),
    baselineRss,
    peakRss,
  }) + "\\n");
} finally {
  clearInterval(sampler);
  client?.destroy();
  if (server) {
    const closeGate = Promise.withResolvers();
    server.close(closeGate.resolve);
    await closeGate.promise;
  }
  if (runDir) await rm(runDir, { recursive: true, force: true });
}
`;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("remote large attachment streaming memory", () => {
  test("streams generated bytes with size-invariant incremental memory", async () => {
    const sourceDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-memory-source-"));
    tempDirs.push(sourceDir);

    const smallSize = 8 * 1024 * 1024;
    const largeSize = MAX_REMOTE_RUN_ATTACHMENT_BYTES;
    const smallPath = await makeSparseSource(sourceDir, "small.bin", smallSize);
    const largePath = await makeSparseSource(sourceDir, "large.bin", largeSize);
    const smallExpected = await hashFile(smallPath);
    const largeExpected = await hashFile(largePath);

    const smallRun = await runProtocolChild(smallPath, smallExpected.size);
    const largeRun = await runProtocolChild(largePath, largeExpected.size);

    for (const [run, expected] of [
      [smallRun, smallExpected],
      [largeRun, largeExpected],
    ] as const) {
      expect(run.preparedHash).toBe(expected.hash);
      expect(run.receivedHash).toBe(expected.hash);
      expect(run.receivedSize).toBe(expected.size);
      expect(run.spooledSize).toBe(expected.size);
      expect(run.peakRss).toBeGreaterThanOrEqual(run.baselineRss);
    }

    const peakIncrease = largeRun.peakDelta - smallRun.peakDelta;
    const maxSizeSensitiveIncrease = 128 * 1024 * 1024;
    expect(peakIncrease).toBeLessThan(maxSizeSensitiveIncrease);
  }, 30_000);
});

async function makeSparseSource(directory: string, name: string, size: number): Promise<string> {
  const filePath = path.join(directory, name);
  const marker = Buffer.allocUnsafe(64 * 1024);
  for (let index = 0; index < marker.length; index += 1) {
    marker[index] = (index * 31 + size) & 0xff;
  }
  await writeFile(filePath, marker);
  await truncate(filePath, size);
  const file = await open(filePath, "r+");
  try {
    await file.write(marker, 0, marker.length, size - marker.length);
  } finally {
    await file.close();
  }
  return filePath;
}

async function hashFile(filePath: string): Promise<{ hash: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { hash: hash.digest("hex"), size };
}

async function runProtocolChild(
  sourcePath: string,
  sourceSize: number,
): Promise<{
  preparedHash: string;
  receivedHash: string;
  receivedSize: number;
  spooledSize: number;
  peakDelta: number;
  baselineRss: number;
  peakRss: number;
}> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", CHILD_SCRIPT],
    {
      cwd: path.dirname(fileURLToPath(PROTOCOL_MODULE)),
      env: {
        ...process.env,
        ORACLE_REMOTE_PROTOCOL_MODULE: PROTOCOL_MODULE,
        ORACLE_REMOTE_SOURCE_PATH: sourcePath,
        ORACLE_REMOTE_SOURCE_SIZE: String(sourceSize),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let resolveResult!: (value: string | PromiseLike<string>) => void;
  let rejectResult!: (reason?: unknown) => void;
  const resultPromise = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // This is a hard cleanup guard for an integration child; the protocol itself has no test clock.
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    rejectResult(new Error(`Remote memory child timed out.\\n${stderr}`));
  }, 90_000);
  child.once("error", (error) => {
    clearTimeout(timeout);
    rejectResult(error);
  });
  child.once("close", (code, signal) => {
    clearTimeout(timeout);
    if (code !== 0) {
      rejectResult(
        new Error(
          `Remote memory child exited with ${code ?? signal}.\\nstdout: ${stdout}\\nstderr: ${stderr}`,
        ),
      );
      return;
    }
    resolveResult(stdout.trim());
  });
  const result = await resultPromise;

  const lastLine = result.split("\\n").at(-1);
  if (!lastLine) throw new Error("Remote memory child produced no result.");
  return JSON.parse(lastLine) as {
    preparedHash: string;
    receivedHash: string;
    receivedSize: number;
    spooledSize: number;
    peakDelta: number;
    baselineRss: number;
    peakRss: number;
  };
}
