import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApprovalGrantAuthority } from "../../browser/approvalToken.js";
import { z } from "zod";
import { loadUserConfig } from "../../config.js";
import { resolveTrustedBrowserConfig } from "../../browser/trustedBrowserConfig.js";
import { CHATGPT_URL } from "../../browser/constants.js";
import { connectToRemoteChrome, closeRemoteChromeTarget } from "../../browser/chromeLifecycle.js";
import { navigateToChatGPT } from "../../browser/actions/navigation.js";
import { createRuntimeProjectLifecycleDriver } from "../../browser/chatgpt/projectLifecycleRuntime.js";
import { ChatgptProjectLifecycleService } from "../../browser/chatgpt/projectLifecycle.js";
import type { ProjectOperationResult } from "../../browser/chatgpt/projectLifecycleTypes.js";

const approvalChallenge = z.object({
  operation: z.string().min(1),
  target: z.string().min(1),
  revision: z.string().min(1),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  expiry: z.number().int().positive(),
});
const approvalGrant = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export interface ProjectLifecycleToolDependencies {
  readonly approvalAuthority?: ApprovalGrantAuthority;
  readonly principal?: string;
  readonly session?: string;
}

const inputShape = {
  operation: z.enum([
    "list",
    "get",
    "create",
    "rename",
    "move",
    "delete",
    "sources",
    "remove_source",
    "branch",
    "share_preview",
    "share_commit",
  ]),
  projectId: z.string().min(1).max(120).optional(),
  projectUrl: z.string().url().optional(),
  sourceId: z.string().min(1).max(240).optional(),
  conversationId: z.string().min(1).max(120).optional(),
  targetProjectId: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(50).optional(),
  instructions: z.string().max(8_000).optional(),
  expectedRevisionHash: z.string().min(1).max(256).optional(),
  approvalChallenge: approvalChallenge.optional(),
  approvalGrant: approvalGrant.optional(),
  dryRun: z.boolean().optional().default(false),
  target: z
    .object({
      kind: z.enum(["link", "workspace", "user"]),
      target: z.string().min(1).max(240).optional(),
    })
    .optional(),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().positive().max(120_000).optional(),
  keepTab: z.boolean().optional().default(false),
} satisfies z.ZodRawShape;

const capabilityShape = z.object({
  pageIdentity: z.enum(["chatgpt_app", "auth", "challenge", "other", "unknown"]),
  loginState: z.enum(["logged_in", "login_required", "challenge_required", "unknown"]),
  projectControls: z.enum(["available", "unavailable", "unknown"]),
  sourceControls: z.enum(["available", "unavailable", "unknown"]),
  shareControls: z.enum(["available", "unavailable", "unknown"]),
  reason: z.string().optional(),
});
const outputShape = {
  state: z.enum(["ok", "unsupported", "requires_action", "conflict", "disconnected"]),
  projectId: z.string().optional(),
  revisionHash: z.string().optional(),
  approvalChallenge: approvalChallenge.optional(),
  reason: z.string().optional(),
  capability: capabilityShape.optional(),
  projects: z.array(z.record(z.string(), z.unknown())).optional(),
  project: z.record(z.string(), z.unknown()).optional(),
  sources: z.array(z.record(z.string(), z.unknown())).optional(),
  preview: z.record(z.string(), z.unknown()).optional(),
  conversation: z.record(z.string(), z.unknown()).optional(),
  sourceId: z.string().optional(),
  parentConversationId: z.string().optional(),
  deleted: z.boolean().optional(),
  shared: z.boolean().optional(),
  removed: z.boolean().optional(),
  branched: z.boolean().optional(),
  changed: z.boolean().optional(),
  created: z.boolean().optional(),
} satisfies z.ZodRawShape;

const inputSchema = z.object(inputShape);

export function registerProjectLifecycleTool(
  server: McpServer,
  dependencies: ProjectLifecycleToolDependencies = {},
): void {
  server.registerTool(
    "chatgpt_project",
    {
      title: "Manage ChatGPT project lifecycle",
      description:
        "List, inspect, create, rename, move, delete, branch, share, and manage sources for a ChatGPT project. Mutating delete/share/source removal always require the exact approval grant for the observed project revision.",
      inputSchema: inputShape,
      outputSchema: outputShape,
    },
    async (input: unknown) => {
      const text = (message: string) => [{ type: "text" as const, text: message }];
      let parsed: z.infer<typeof inputSchema>;
      try {
        parsed = inputSchema.parse(input);
      } catch (error) {
        return {
          isError: true,
          content: text(error instanceof Error ? error.message : String(error)),
        };
      }
      const { config: userConfig } = await loadUserConfig();
      const browserConfig = await resolveTrustedBrowserConfig(parsed.remoteChrome);
      const remote = browserConfig.remoteChrome;
      if (!remote)
        return {
          isError: true,
          content: text("chatgpt_project requires a signed-in browser.remoteChrome connection."),
        };
      const projectUrl =
        parsed.projectUrl ??
        userConfig.browser?.chatgptUrl ??
        userConfig.browser?.url ??
        CHATGPT_URL;
      const connection = await connectToRemoteChrome(
        remote.host,
        remote.port,
        () => undefined,
        projectUrl,
        undefined,
        { maxTabs: browserConfig.remoteChromeMaxTabs },
      );
      const client = connection.client;
      let result: ProjectOperationResult;
      try {
        await Promise.all([client.Page.enable(), client.Runtime.enable()]);
        await navigateToChatGPT(client.Page, client.Runtime, projectUrl, () => undefined);
        const service = new ChatgptProjectLifecycleService(
          createRuntimeProjectLifecycleDriver({
            Runtime: client.Runtime,
            Input: client.Input,
            timeoutMs: parsed.timeoutMs,
            logger: () => undefined,
          }),
          {
            approvalAuthority: dependencies.approvalAuthority,
            principal: dependencies.principal,
            session: dependencies.session,
          },
        );
        switch (parsed.operation) {
          case "list":
            result = await service.listProjects();
            break;
          case "get":
            result = await service.getProject(required(parsed.projectId, "projectId"));
            break;
          case "create":
            result = await service.createProject({
              name: required(parsed.name, "name"),
              instructions: parsed.instructions,
            });
            break;
          case "rename":
            result = await service.renameProject({
              projectId: required(parsed.projectId, "projectId"),
              name: required(parsed.name, "name"),
              expectedRevisionHash: parsed.expectedRevisionHash,
            });
            break;
          case "move":
            result = await service.moveProject({
              projectId: required(parsed.projectId, "projectId"),
              targetProjectId: required(parsed.targetProjectId, "targetProjectId"),
              expectedRevisionHash: parsed.expectedRevisionHash,
            });
            break;
          case "delete":
            result = await service.deleteProject({
              projectId: required(parsed.projectId, "projectId"),
              expectedRevisionHash: parsed.expectedRevisionHash,
              approvalChallenge: parsed.approvalChallenge,
              approvalGrant: parsed.approvalGrant,
              dryRun: parsed.dryRun,
            });
            break;
          case "sources":
            result = await service.listProjectSources(required(parsed.projectId, "projectId"));
            break;
          case "remove_source":
            result = await service.removeProjectSource({
              projectId: required(parsed.projectId, "projectId"),
              sourceId: required(parsed.sourceId, "sourceId"),
              expectedRevisionHash: parsed.expectedRevisionHash,
              approvalChallenge: parsed.approvalChallenge,
              approvalGrant: parsed.approvalGrant,
              dryRun: parsed.dryRun,
            });
            break;
          case "branch":
            result = await service.branchProjectConversation({
              projectId: required(parsed.projectId, "projectId"),
              parentConversationId: required(parsed.conversationId, "conversationId"),
              expectedRevisionHash: parsed.expectedRevisionHash,
            });
            break;
          case "share_preview":
            result = await service.previewProjectShare({
              projectId: required(parsed.projectId, "projectId"),
              target: parsed.target ?? { kind: "link" },
              expectedRevisionHash: parsed.expectedRevisionHash,
              dryRun: true,
            });
            break;
          case "share_commit":
            result = await service.shareProject({
              projectId: required(parsed.projectId, "projectId"),
              target: parsed.target ?? { kind: "link" },
              expectedRevisionHash: parsed.expectedRevisionHash,
              approvalChallenge: parsed.approvalChallenge,
              approvalGrant: parsed.approvalGrant,
              dryRun: parsed.dryRun,
            });
            break;
        }
      } catch (error) {
        return {
          isError: true,
          content: text(error instanceof Error ? error.message : String(error)),
        };
      } finally {
        try {
          await client.close();
        } finally {
          if (!parsed.keepTab)
            await closeRemoteChromeTarget(
              remote.host,
              remote.port,
              connection.targetId,
              () => undefined,
            );
        }
      }
      return {
        structuredContent: result as unknown as Record<string, unknown>,
        content: text(`ChatGPT project ${parsed.operation}: ${result.state}.`),
      };
    },
  );
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}
