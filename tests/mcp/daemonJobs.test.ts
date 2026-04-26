import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createDaemonClientFromConnection } from "../../src/daemon/client.js";
import { createOracleDaemonServer, writeConnectionArtifact } from "../../src/daemon/server.js";
import type { OracleDaemonConnection } from "../../src/daemon/types.js";

describe("daemon-backed MCP job substrate", () => {
  const previousConnection = process.env.ORACLE_DAEMON_CONNECTION;
  const roots: string[] = [];

  afterEach(async () => {
    process.env.ORACLE_DAEMON_CONNECTION = previousConnection;
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("daemon connection artifact supports separate client status/result reads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-mcp-daemon-"));
    roots.push(root);
    const jobDir = path.join(root, "jobs");
    const connectionPath = path.join(root, "connection.json");
    const server = await createOracleDaemonServer({
      host: "127.0.0.1",
      port: 0,
      token: "secret",
      jobDir,
      connectionPath,
      logger: () => {},
    });
    try {
      const connection: OracleDaemonConnection = {
        version: 1,
        pid: process.pid,
        host: "127.0.0.1",
        port: server.port,
        token: "secret",
        startedAt: new Date().toISOString(),
        jobDir,
      };
      await writeConnectionArtifact(connectionPath, connection);
      process.env.ORACLE_DAEMON_CONNECTION = connectionPath;

      const submitClient = createDaemonClientFromConnection(connection);
      const started = await submitClient.startJob({
        kind: "test_sleep",
        input: { ms: 5, result: { answerText: "ok" } },
      });

      const pollClient = createDaemonClientFromConnection(connection);
      let status: any;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        status = await pollClient.jobStatus(started.jobId);
        if (status.job?.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(status.job.status).toBe("completed");

      const result = (await pollClient.jobResult(started.jobId)) as any;
      expect(result.ready).toBe(true);
      expect(result.result.answerText).toBe("ok");
    } finally {
      await server.close();
    }
  });
});
