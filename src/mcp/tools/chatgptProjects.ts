import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadUserConfig } from "../../config.js";
import { buildBrowserConfig } from "../../cli/browserConfig.js";
import { DEFAULT_MODEL } from "../../oracle.js";
import {
  createChatgptProject,
  deleteChatgptConversation,
  listChatgptProjects,
  moveChatgptConversationToProject,
  planChatgptConversationDelete,
  readChatgptProject,
  renameChatgptProject,
} from "../../browser/chatgpt/projects.js";

const listProjectsInputShape = {
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().optional(),
  keepTab: z.boolean().optional().default(false),
} satisfies z.ZodRawShape;

const getProjectInputShape = {
  projectUrl: z.string().url(),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().optional(),
  keepTab: z.boolean().optional().default(false),
} satisfies z.ZodRawShape;

const createProjectInputShape = {
  name: z.string().min(1).max(50),
  instructions: z.string().optional(),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().optional(),
  keepTab: z.boolean().optional().default(false),
} satisfies z.ZodRawShape;

const deletePlanInputShape = {
  conversationUrl: z.string().url(),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().optional(),
  keepTab: z.boolean().optional().default(false),
} satisfies z.ZodRawShape;

const deleteConversationInputShape = {
  conversationUrl: z.string().url(),
  confirmConversationId: z.string().min(1),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().optional(),
  keepTab: z.boolean().optional().default(false),
} satisfies z.ZodRawShape;

const moveConversationInputShape = {
  conversationUrl: z.string().url(),
  targetProjectUrl: z.string().url(),
  confirmConversationId: z.string().min(1),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().optional(),
  keepTab: z.boolean().optional().default(false),
} satisfies z.ZodRawShape;

const renameProjectInputShape = {
  projectUrl: z.string().url(),
  newName: z.string().min(1),
  confirmCurrentName: z.string().min(1),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().optional(),
  keepTab: z.boolean().optional().default(false),
} satisfies z.ZodRawShape;

const projectShape = z.object({
  name: z.string(),
  url: z.string().optional(),
  projectId: z.string().optional(),
  documentIndex: z.number(),
});

const conversationRefShape = z.object({
  title: z.string(),
  url: z.string(),
  conversationId: z.string().optional(),
  projectId: z.string().optional(),
  documentIndex: z.number(),
});

const pageShape = z.object({
  href: z.string(),
  title: z.string(),
  readyState: z.string(),
  hasComposer: z.boolean(),
  loginLikely: z.boolean(),
  imageNodeCount: z.number(),
  generatedImageNodeCount: z.number(),
  uniqueGeneratedImageCount: z.number(),
  conversationId: z.string().optional(),
  hasModelMenu: z.boolean().optional(),
  modelMenuLabel: z.string().optional(),
  hasFileUploadControl: z.boolean().optional(),
  hasPhotoUploadControl: z.boolean().optional(),
  hasComposerPlusButton: z.boolean().optional(),
});

const listProjectsOutputShape = {
  page: pageShape,
  projects: z.array(projectShape),
  warnings: z.array(z.string()),
} satisfies z.ZodRawShape;

const getProjectOutputShape = {
  page: pageShape,
  project: projectShape,
  conversations: z.array(conversationRefShape),
  warnings: z.array(z.string()),
} satisfies z.ZodRawShape;

const createProjectOutputShape = {
  pageBefore: pageShape,
  pageAfter: pageShape,
  project: projectShape,
  created: z.boolean(),
  verification: z.enum(["project_page_opened", "response_project_id", "not_verified"]),
  warnings: z.array(z.string()),
} satisfies z.ZodRawShape;

const deletePlanOutputShape = {
  page: pageShape,
  conversationUrl: z.string(),
  conversationId: z.string().optional(),
  matchedConversation: conversationRefShape.optional(),
  canAttemptDelete: z.boolean(),
  warnings: z.array(z.string()),
} satisfies z.ZodRawShape;

const deleteConversationOutputShape = {
  pageBefore: pageShape,
  pageAfter: pageShape,
  conversationUrl: z.string(),
  conversationId: z.string(),
  matchedConversation: conversationRefShape.optional(),
  deleted: z.boolean(),
  verification: z.enum(["url_changed", "conversation_unavailable", "not_verified"]),
  warnings: z.array(z.string()),
} satisfies z.ZodRawShape;

const moveConversationOutputShape = {
  pageBefore: pageShape,
  pageAfter: pageShape,
  conversationUrl: z.string(),
  conversationId: z.string(),
  targetProject: projectShape,
  movedConversation: conversationRefShape.optional(),
  moved: z.boolean(),
  verification: z.enum([
    "project_link_found",
    "page_title_project",
    "url_changed_to_project",
    "not_verified",
  ]),
  warnings: z.array(z.string()),
} satisfies z.ZodRawShape;

const renameProjectOutputShape = {
  pageBefore: pageShape,
  pageAfter: pageShape,
  projectBefore: projectShape,
  projectAfter: projectShape,
  oldName: z.string(),
  newName: z.string(),
  renamed: z.boolean(),
  verification: z.enum(["name_updated", "unchanged_same_name", "not_verified"]),
  warnings: z.array(z.string()),
} satisfies z.ZodRawShape;

export function registerChatgptProjectsTool(server: McpServer): void {
  server.registerTool(
    "chatgpt_create_project",
    {
      title: "Create ChatGPT project",
      description:
        "Create a ChatGPT project through the logged-in browser session and return its project URL.",
      inputSchema: createProjectInputShape,
      outputSchema: createProjectOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(createProjectInputShape).parse(input);
      const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
      const structuredContent = await createChatgptProject({
        name: parsed.name,
        instructions: parsed.instructions,
        timeoutMs: parsed.timeoutMs,
        keepTab: parsed.keepTab,
        config,
      });
      return {
        structuredContent: { ...structuredContent },
        content: [
          {
            type: "text" as const,
            text: structuredContent.created
              ? `Created ChatGPT project ${structuredContent.project.name}.`
              : `Project create returned for ${structuredContent.project.name}, but verification did not complete.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "chatgpt_list_projects",
    {
      title: "List ChatGPT projects",
      description: "List ChatGPT projects visible in the logged-in browser sidebar.",
      inputSchema: listProjectsInputShape,
      outputSchema: listProjectsOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(listProjectsInputShape).parse(input);
      const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
      const structuredContent = await listChatgptProjects({
        timeoutMs: parsed.timeoutMs,
        keepTab: parsed.keepTab,
        config,
      });
      return {
        structuredContent: { ...structuredContent },
        content: [
          {
            type: "text" as const,
            text: `Found ${structuredContent.projects.length} ChatGPT project(s).`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "chatgpt_get_project",
    {
      title: "Read ChatGPT project",
      description:
        "Read a ChatGPT project page and return the visible conversation links without modifying the project.",
      inputSchema: getProjectInputShape,
      outputSchema: getProjectOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(getProjectInputShape).parse(input);
      const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
      const structuredContent = await readChatgptProject({
        projectUrl: parsed.projectUrl,
        timeoutMs: parsed.timeoutMs,
        keepTab: parsed.keepTab,
        config,
      });
      return {
        structuredContent: { ...structuredContent },
        content: [
          {
            type: "text" as const,
            text: `Read project ${structuredContent.project.name} with ${structuredContent.conversations.length} visible conversation(s).`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "chatgpt_plan_delete_conversation",
    {
      title: "Plan ChatGPT conversation deletion",
      description:
        "Inspect a ChatGPT conversation and report whether deletion can be attempted. This tool does not delete anything.",
      inputSchema: deletePlanInputShape,
      outputSchema: deletePlanOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(deletePlanInputShape).parse(input);
      const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
      const structuredContent = await planChatgptConversationDelete({
        conversationUrl: parsed.conversationUrl,
        timeoutMs: parsed.timeoutMs,
        keepTab: parsed.keepTab,
        config,
      });
      return {
        structuredContent: { ...structuredContent },
        content: [
          {
            type: "text" as const,
            text: structuredContent.canAttemptDelete
              ? `Conversation ${structuredContent.conversationId ?? parsed.conversationUrl} is eligible for a delete attempt.`
              : `Conversation ${parsed.conversationUrl} is not ready for a delete attempt.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "chatgpt_delete_conversation",
    {
      title: "Delete ChatGPT conversation",
      description:
        "Delete a ChatGPT conversation through the logged-in browser. Requires exact conversation id confirmation parsed from the URL.",
      inputSchema: deleteConversationInputShape,
      outputSchema: deleteConversationOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(deleteConversationInputShape).parse(input);
      const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
      const structuredContent = await deleteChatgptConversation({
        conversationUrl: parsed.conversationUrl,
        confirmConversationId: parsed.confirmConversationId,
        timeoutMs: parsed.timeoutMs,
        keepTab: parsed.keepTab,
        config,
      });
      return {
        structuredContent: { ...structuredContent },
        content: [
          {
            type: "text" as const,
            text: structuredContent.deleted
              ? `Deleted ChatGPT conversation ${structuredContent.conversationId}.`
              : `Delete attempted for ${structuredContent.conversationId}, but verification did not complete.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "chatgpt_move_conversation_to_project",
    {
      title: "Move ChatGPT conversation to project",
      description:
        "Move a ChatGPT conversation into a target project through the logged-in browser. Requires exact conversation id confirmation parsed from the URL.",
      inputSchema: moveConversationInputShape,
      outputSchema: moveConversationOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(moveConversationInputShape).parse(input);
      const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
      const structuredContent = await moveChatgptConversationToProject({
        conversationUrl: parsed.conversationUrl,
        targetProjectUrl: parsed.targetProjectUrl,
        confirmConversationId: parsed.confirmConversationId,
        timeoutMs: parsed.timeoutMs,
        keepTab: parsed.keepTab,
        config,
      });
      return {
        structuredContent: { ...structuredContent },
        content: [
          {
            type: "text" as const,
            text: structuredContent.moved
              ? `Moved ChatGPT conversation ${structuredContent.conversationId} to ${structuredContent.targetProject.name}.`
              : `Move attempted for ${structuredContent.conversationId}, but verification did not complete.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "chatgpt_rename_project",
    {
      title: "Rename ChatGPT project",
      description:
        "Rename a ChatGPT project through the logged-in browser. Requires exact current-name confirmation.",
      inputSchema: renameProjectInputShape,
      outputSchema: renameProjectOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(renameProjectInputShape).parse(input);
      const config = await resolveMcpBrowserConfig(parsed.remoteChrome);
      const structuredContent = await renameChatgptProject({
        projectUrl: parsed.projectUrl,
        newName: parsed.newName,
        confirmCurrentName: parsed.confirmCurrentName,
        timeoutMs: parsed.timeoutMs,
        keepTab: parsed.keepTab,
        config,
      });
      return {
        structuredContent: { ...structuredContent },
        content: [
          {
            type: "text" as const,
            text: structuredContent.renamed
              ? `Renamed ChatGPT project ${structuredContent.oldName} to ${structuredContent.newName}.`
              : `Rename attempted for ${structuredContent.oldName}, but verification did not complete.`,
          },
        ],
      };
    },
  );
}

async function resolveMcpBrowserConfig(remoteChrome?: string) {
  const { config: userConfig } = await loadUserConfig();
  const cliBrowserConfig = remoteChrome
    ? await buildBrowserConfig({ model: DEFAULT_MODEL, remoteChrome })
    : {};
  return {
    ...(userConfig.browser ?? {}),
    ...cliBrowserConfig,
    remoteChrome: cliBrowserConfig.remoteChrome ?? userConfig.browser?.remoteChrome ?? null,
  };
}
