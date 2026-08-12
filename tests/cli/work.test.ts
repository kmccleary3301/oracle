import { afterEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  ApprovalGrantAuthority,
  createApprovalChallenge,
} from "../../src/browser/approvalToken.js";

const execFileAsync = promisify(execFile);
const cliEntry = path.join(process.cwd(), "bin", "oracle-cli.ts");

type RequestRecord = { path: string; body: Record<string, unknown> };

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function startFakeDaemon(requests: RequestRecord[]): Promise<{
  server: Server;
  connectionPath: string;
}> {
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    requests.push({ path: request.url ?? "", body });
    const payload =
      request.url === "/work/start"
        ? {
            jobId: "job-work-1",
            kind: "chatgpt_work_start",
            status: "queued",
            phase: "queued",
            pollTool: "oracle_job_status",
            attachTool: "oracle_job_events",
            resultTool: "oracle_job_result",
            estimatedQueuePosition: 0,
          }
        : {
            operation: request.url?.split("/").at(-1),
            state: "waiting_for_plan_approval",
            reason: "needs-approval",
            actionRequired: { kind: "manual_confirmation_required" },
            runtime: { tabId: "tab-work-1" },
          };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake daemon did not bind");
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-work-cli-"));
  const connectionPath = path.join(dir, "connection.json");
  await writeFile(
    connectionPath,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      host: "127.0.0.1",
      port: address.port,
      token: "work-cli-test-token",
      startedAt: new Date().toISOString(),
      jobDir: dir,
    }),
  );
  return { server, connectionPath };
}

async function runCli(args: string[], connectionPath: string) {
  return await execFileAsync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    env: { ...process.env, ORACLE_DAEMON_CONNECTION: connectionPath },
    maxBuffer: 1024 * 1024,
  });
}

describe("oracle work CLI", () => {
  let server: Server | undefined;
  let tempDirs: string[] = [];

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });
  test("issues a restart-durable one-time grant only after local confirmation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-approval-cli-"));
    tempDirs.push(directory);
    const dbPath = path.join(directory, "approval.sqlite");
    const challenge = createApprovalChallenge({
      operation: "work.approve",
      target: "conversation-1:task-1",
      revision: "revision-1",
      payload: { decision: "approve" },
      expiry: Date.now() + 60_000,
    });
    const args = [
      "approval",
      "issue",
      "--challenge",
      JSON.stringify(challenge),
      "--db-path",
      dbPath,
      "--json",
    ];

    await expect(
      runCli(args, path.join(directory, "unused-connection.json")),
    ).rejects.toMatchObject({
      code: 1,
    });
    await expect(readFile(dbPath)).rejects.toThrow();

    const issued = await runCli(
      [...args.slice(0, -1), "--yes", "--json"],
      path.join(directory, "unused-connection.json"),
    );
    const payload = JSON.parse(issued.stdout) as {
      grant: string;
      challenge: typeof challenge;
    };
    expect(payload).toMatchObject({ challenge });
    expect(payload.grant).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const restarted = new ApprovalGrantAuthority({ dbPath });
    expect(restarted.consumeGrant(payload.grant, challenge).state).toBe("consumed");
    restarted.close();
  }, 15_000);

  test("dispatches all five Work operations with exact identity and approval fields", async () => {
    const requests: RequestRecord[] = [];
    const fake = await startFakeDaemon(requests);
    server = fake.server;

    const commands = [
      ["work", "start", "--prompt", "Inspect the repository", "--task-id", "task-1", "--json"],
      ["work", "status", "--conversation-id", "conversation-1", "--task-id", "task-1", "--json"],
      [
        "work",
        "answer",
        "--conversation-id",
        "conversation-1",
        "--task-id",
        "task-1",
        "--question-id",
        "question-1",
        "--revision-hash",
        "revision-1",
        "--answer",
        "Proceed",
        "--json",
      ],
      [
        "work",
        "approve",
        "--conversation-id",
        "conversation-1",
        "--task-id",
        "task-1",
        "--revision-hash",
        "revision-1",
        "--approval-grant",
        "grant-1",
        "--dry-run",
        "--json",
      ],
      [
        "work",
        "interrupt",
        "--conversation-id",
        "conversation-1",
        "--task-id",
        "task-1",
        "--turn-id",
        "turn-1",
        "--json",
      ],
    ];

    for (const [index, command] of commands.entries()) {
      const result = await runCli(command, fake.connectionPath);
      expect(result.stdout).toContain(index === 0 ? '"jobId"' : '"state"');
    }

    expect(requests.map((request) => request.path)).toEqual([
      "/work/start",
      "/work/status",
      "/work/answer",
      "/work/approve",
      "/work/interrupt",
    ]);
    expect(requests[0]?.body).toMatchObject({ prompt: "Inspect the repository", taskId: "task-1" });
    expect(requests[1]?.body).toMatchObject({ conversationId: "conversation-1", taskId: "task-1" });
    expect(requests[2]?.body).toMatchObject({
      conversationId: "conversation-1",
      taskId: "task-1",
      questionId: "question-1",
      expectedRevisionHash: "revision-1",
      answer: "Proceed",
    });
    expect(requests[3]?.body).toMatchObject({
      conversationId: "conversation-1",
      taskId: "task-1",
      expectedRevisionHash: "revision-1",
      approvalGrant: "grant-1",
      dryRun: true,
    });
    expect(requests[4]?.body).toMatchObject({
      conversationId: "conversation-1",
      taskId: "task-1",
      turnId: "turn-1",
    });
  });

  test("rejects missing required identity and approval arguments before dispatch", async () => {
    const requests: RequestRecord[] = [];
    const fake = await startFakeDaemon(requests);
    server = fake.server;

    await expect(runCli(["work", "start", "--json"], fake.connectionPath)).rejects.toMatchObject({
      code: 1,
    });
    await expect(runCli(["work", "status", "--json"], fake.connectionPath)).rejects.toMatchObject({
      code: 1,
    });
    await expect(
      runCli(
        [
          "work",
          "answer",
          "--conversation-id",
          "conversation-1",
          "--task-id",
          "task-1",
          "--question-id",
          "question-1",
          "--json",
        ],
        fake.connectionPath,
      ),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      runCli(
        [
          "work",
          "approve",
          "--conversation-id",
          "conversation-1",
          "--task-id",
          "task-1",
          "--revision-hash",
          "revision-1",
          "--json",
        ],
        fake.connectionPath,
      ),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      runCli(
        [
          "work",
          "interrupt",
          "--conversation-id",
          "conversation-1",
          "--task-id",
          "task-1",
          "--json",
        ],
        fake.connectionPath,
      ),
    ).rejects.toMatchObject({ code: 1 });
    expect(requests).toHaveLength(0);
  }, 15_000);
});
