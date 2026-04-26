import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDaemonClientFromConnection,
  readDaemonConnectionArtifact,
  type OracleDaemonClient,
} from "./client.js";
import { resolveOracleDaemonConfig } from "./config.js";

export async function resolveDaemonClientWithOptionalAutostart(): Promise<OracleDaemonClient | null> {
  const config = await resolveOracleDaemonConfig();
  let connection = await readDaemonConnectionArtifact(config.connectionPath);
  if (connection) {
    return createDaemonClientFromConnection(connection);
  }
  if (!config.enabled || !config.autoStart) {
    return null;
  }
  await startDaemonBackgroundFromCurrentInstall(config.connectionPath);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    connection = await readDaemonConnectionArtifact(config.connectionPath);
    if (connection) {
      return createDaemonClientFromConnection(connection);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function startDaemonBackgroundFromCurrentInstall(connectionPath: string): Promise<void> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidateCli = path.resolve(currentDir, "..", "..", "bin", "oracle-cli.js");
  const child = spawn(
    process.execPath,
    [candidateCli, "daemon", "start", "--background", "--connection-path", connectionPath],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
}
