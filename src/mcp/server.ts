#!/usr/bin/env node
import "dotenv/config";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getOracleHomeDir } from "../oracleHome.js";
import { getCliVersion } from "../version.js";
import { registerChatGptImageTool } from "./tools/chatgptImage.js";
import { registerConsultTool } from "./tools/consult.js";
import { registerProjectSourcesTool } from "./tools/projectSources.js";
import { registerSessionsTool } from "./tools/sessions.js";
import { registerSessionResources } from "./tools/sessionResources.js";
import { registerChatgptImagesTool } from "./tools/chatgptImages.js";
import { registerChatgptSessionTools } from "./tools/chatgptSession.js";
import { registerChatgptProjectsTool } from "./tools/chatgptProjects.js";
import { registerProjectLifecycleTool } from "./tools/projectLifecycle.js";
import { registerMcpJobTools } from "./tools/jobs.js";
import { registerChatgptFilesTools } from "./tools/chatgptFiles.js";
import { registerChatgptWritingTool } from "./tools/chatgptWriting.js";
import { registerChatgptHistorySchedulesTools } from "./tools/chatgptHistorySchedules.js";
import { registerChatgptAppsTools } from "./tools/chatgptApps.js";
import { registerChatgptWorkTools } from "./tools/chatgptWork.js";
import { registerChatgptResearchTools } from "./tools/chatgptResearch.js";

import type { ChatgptFileDownloadPolicy } from "../browser/chatgpt/types.js";
import { ApprovalGrantAuthority, defaultApprovalGrantDbPath } from "../browser/approvalToken.js";

export interface McpToolDependencies {
  readonly approvalAuthority?: ApprovalGrantAuthority;
  readonly principal?: string;
  readonly session?: string;
  readonly fileDownloadPolicy?: ChatgptFileDownloadPolicy;
}

export function registerMcpTools(server: McpServer, dependencies: McpToolDependencies = {}): void {
  registerConsultTool(server);
  registerChatGptImageTool(server);
  registerProjectSourcesTool(server);
  registerSessionsTool(server);
  registerChatgptImagesTool(server);
  registerChatgptSessionTools(server);
  registerChatgptProjectsTool(server);
  registerProjectLifecycleTool(server, dependencies);
  registerMcpJobTools(server);
  registerChatgptFilesTools(server, { policy: dependencies.fileDownloadPolicy });
  registerChatgptResearchTools(server);
  registerChatgptWorkTools(server);
  registerChatgptWritingTool(server, dependencies);
  registerChatgptHistorySchedulesTools(server, dependencies);
  registerChatgptAppsTools(server, dependencies);
  registerSessionResources(server);
}

export function resolveMcpFileDownloadPolicy(): ChatgptFileDownloadPolicy {
  const configuredMaxBytes = process.env.ORACLE_FILE_DOWNLOAD_MAX_BYTES;
  const maxDownloadBytes =
    configuredMaxBytes === undefined ? 512 * 1024 * 1024 : Number(configuredMaxBytes);
  if (!Number.isSafeInteger(maxDownloadBytes) || maxDownloadBytes <= 0) {
    throw new Error("ORACLE_FILE_DOWNLOAD_MAX_BYTES must be a positive safe integer.");
  }
  return {
    maxDownloadBytes,
    approvedOutputRoot: path.resolve(
      process.env.ORACLE_FILE_DOWNLOAD_ROOT ?? path.join(getOracleHomeDir(), "downloads"),
    ),
  };
}

export async function startMcpServer(): Promise<void> {
  const fileDownloadPolicy = resolveMcpFileDownloadPolicy();
  await mkdir(fileDownloadPolicy.approvedOutputRoot, { recursive: true, mode: 0o700 });
  const approvalAuthority = new ApprovalGrantAuthority({
    dbPath: process.env.ORACLE_APPROVAL_GRANT_DB || defaultApprovalGrantDbPath(),
  });
  try {
    const server = new McpServer(
      {
        name: "oracle-mcp",
        version: getCliVersion(),
      },
      {
        capabilities: {
          logging: {},
        },
      },
    );

    registerMcpTools(server, { approvalAuthority, fileDownloadPolicy });

    const transport = new StdioServerTransport();
    transport.onerror = (error) => {
      console.error("MCP transport error:", error);
    };
    const transportClosed = new Promise<void>((resolve) => {
      transport.onclose = () => {
        approvalAuthority.close();
        resolve();
      };
    });

    // Keep the process alive until the client closes the transport.
    await server.connect(transport);
    await transportClosed;
  } catch (error) {
    approvalAuthority.close();
    throw error;
  }
}

export function shouldStartMcpServerFromModule(
  moduleUrl: string = import.meta.url,
  argv1: string | undefined = process.argv[1],
): boolean {
  return argv1 ? moduleUrl === pathToFileURL(argv1).href : false;
}

if (shouldStartMcpServerFromModule()) {
  startMcpServer().catch((error) => {
    console.error("Failed to start oracle-mcp:", error);
    process.exitCode = 1;
  });
}
