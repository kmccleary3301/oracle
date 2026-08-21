import { z } from "zod";
import { resolveTrustedBrowserConfig } from "../browser/trustedBrowserConfig.js";
import {
  connectToRemoteChrome,
  closeRemoteChromeTarget,
  type RemoteChromeConnection,
} from "../browser/chromeLifecycle.js";
import { navigateToChatGPT } from "../browser/actions/navigation.js";
import {
  startResearch,
  planResearch,
  getResearch,
  interruptResearch,
  downloadResearch,
  type ResearchSourceAllowlist,
} from "../browser/chatgpt/research.js";
import type { ApprovalChallenge, ApprovalGrantAuthority } from "../browser/approvalToken.js";
import type { OracleDaemonJobHandler, OracleDaemonJobHandlerContext } from "./types.js";

export type ResearchPageConnection = RemoteChromeConnection & { host: string; port: number };

const sourceAllowlistSchema = z.object({
  sites: z.array(z.string().min(1)).optional().default([]),
  apps: z.array(z.string().min(1)).optional().default([]),
});
const approvalChallengeSchema = z.object({
  operation: z.string().min(1),
  target: z.string().min(1),
  revision: z.string().min(1),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  expiry: z.number().int().positive(),
});
const baseSchema = z.object({
  conversationUrl: z.string().url().optional(),
  conversationId: z.string().optional(),
  remoteChrome: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
});
const startSchema = baseSchema.extend({
  prompt: z.string().min(1),
  sourceAllowlist: sourceAllowlistSchema.optional(),
  browserModelStrategy: z.enum(["select", "current", "ignore"]).optional(),
});
const planSchema = baseSchema.extend({
  conversationUrl: z.string().url(),
  conversationId: z.string().min(1),
  dryRun: z.boolean().optional(),
  approve: z.boolean().optional(),
  approvalChallenge: approvalChallengeSchema.optional(),
  approvalGrant: z.string().optional(),
  expectedRevisionHash: z.string().optional(),
  edits: z
    .object({
      summary: z.string().optional(),
      action: z.string().optional(),
      sites: z.array(z.string()).optional(),
      apps: z.array(z.string()).optional(),
    })
    .optional(),
});
const getSchema = baseSchema.extend({
  conversationUrl: z.string().url(),
  conversationId: z.string().min(1),
  wait: z.boolean().optional(),
});
const interruptSchema = baseSchema.extend({
  conversationUrl: z.string().url(),
  conversationId: z.string().min(1),
  turnId: z.string().nullable().optional(),
});
const downloadSchema = z.object({
  reportMarkdown: z.string().min(1),
  outputDir: z.string().min(1),
  formats: z.array(z.enum(["markdown", "docx", "pdf"])).optional(),
  conversationUrl: z.string().url().nullable().optional(),
  conversationId: z.string().nullable().optional(),
  turnId: z.string().nullable().optional(),
  messageId: z.string().nullable().optional(),
});
export interface ResearchDaemonHandlerOptions {
  approvalAuthority?: ApprovalGrantAuthority;
  principal?: string;
  session?: string;
}

export function createResearchDaemonHandlers(
  options: ResearchDaemonHandlerOptions = {},
): OracleDaemonJobHandler[] {
  return [
    {
      kind: "chatgpt_research_start",
      async run(context, input) {
        const parsed = startSchema.parse(input);
        await context.setPhase("selecting_model", "Preparing Deep Research mode.");
        const connection = await openResearchPage(
          parsed.remoteChrome,
          parsed.conversationUrl,
          context,
        );
        try {
          await context.setPhase("submitting_prompt", "Starting Deep Research.");
          const result = await startResearch({
            Runtime: connection.client.Runtime,
            Input: connection.client.Input,
            prompt: parsed.prompt,
            timeoutMs: parsed.timeoutMs,
            conversationId: parsed.conversationId,
            sourceAllowlist: parsed.sourceAllowlist as ResearchSourceAllowlist,
            logger: (message) => {
              void context.log(message);
            },
          });
          await context.updateRuntime({
            conversationUrl: result.conversationUrl ?? parsed.conversationUrl,
            conversationId: result.conversationId ?? parsed.conversationId,
          });
          return result;
        } finally {
          await closeResearchPage(connection, context);
        }
      },
    },
    {
      kind: "chatgpt_research_plan",
      async run(context, input) {
        const parsed = planSchema.parse(input);
        const connection = await openResearchPage(
          parsed.remoteChrome,
          parsed.conversationUrl,
          context,
        );
        try {
          await context.setPhase("waiting_for_response", "Capturing Deep Research plan.");
          return await planResearch({
            Runtime: connection.client.Runtime,
            Input: connection.client.Input,
            conversationId: parsed.conversationId,
            dryRun: parsed.dryRun,
            approve: parsed.approve,
            approvalChallenge: parsed.approvalChallenge as ApprovalChallenge | undefined,
            approvalGrant: parsed.approvalGrant,
            approvalAuthority: options.approvalAuthority,
            principal: options.principal,
            session: options.session,
            expectedRevisionHash: parsed.expectedRevisionHash,
            edits: parsed.edits,
          });
        } finally {
          await closeResearchPage(connection, context);
        }
      },
    },
    {
      kind: "chatgpt_research_get",
      async run(context, input) {
        const parsed = getSchema.parse(input);
        const connection = await openResearchPage(
          parsed.remoteChrome,
          parsed.conversationUrl,
          context,
        );
        try {
          await context.setPhase("waiting_for_response", "Reading Deep Research progress.");
          return await getResearch({
            Runtime: connection.client.Runtime,
            Page: connection.client.Page,
            client: connection.client,
            conversationId: parsed.conversationId,
            wait: parsed.wait,
            timeoutMs: parsed.timeoutMs,
            logger: (message) => {
              void context.log(message);
            },
          });
        } finally {
          await closeResearchPage(connection, context);
        }
      },
    },
    {
      kind: "chatgpt_research_interrupt",
      async run(context, input) {
        const parsed = interruptSchema.parse(input);
        const connection = await openResearchPage(
          parsed.remoteChrome,
          parsed.conversationUrl,
          context,
        );
        try {
          await context.setPhase(
            "requires_action",
            "Interrupting the targeted Deep Research turn.",
          );
          return await interruptResearch({
            Runtime: connection.client.Runtime,
            Input: connection.client.Input,
            conversationId: parsed.conversationId,
            turnId: parsed.turnId,
          });
        } finally {
          await closeResearchPage(connection, context);
        }
      },
    },
    {
      kind: "chatgpt_research_download",
      async run(context, input) {
        const parsed = downloadSchema.parse(input);
        await context.setPhase(
          "extracting_sandbox_artifacts",
          "Writing Deep Research report downloads.",
        );
        return await downloadResearch(parsed);
      },
    },
  ];
}

const resolveResearchConfig = resolveTrustedBrowserConfig;
async function openResearchPage(
  remoteChrome: string | undefined,
  conversationUrl: string | undefined,
  context: OracleDaemonJobHandlerContext,
): Promise<ResearchPageConnection> {
  const config = await resolveResearchConfig(remoteChrome);
  if (!config.remoteChrome)
    throw new Error("Deep Research requires browser.remoteChrome or remoteChrome.");
  const targetUrl = conversationUrl ?? config.chatgptUrl ?? config.url;
  if (!targetUrl) throw new Error("Deep Research requires a ChatGPT URL.");
  const logger = (message: string) => {
    void context.log(message);
  };
  const connection = await connectToRemoteChrome(
    config.remoteChrome.host,
    config.remoteChrome.port,
    logger,
    targetUrl,
    undefined,
    { maxTabs: config.remoteChromeMaxTabs },
  );
  await Promise.all([connection.client.Page.enable(), connection.client.Runtime.enable()]);
  await navigateToChatGPT(connection.client.Page, connection.client.Runtime, targetUrl, logger);
  await context.updateRuntime({
    remoteChrome: `${config.remoteChrome.host}:${config.remoteChrome.port}`,
    tabId: connection.targetId,
    conversationUrl: targetUrl,
  });
  return { ...connection, host: config.remoteChrome.host, port: config.remoteChrome.port };
}
async function closeResearchPage(
  connection: ResearchPageConnection,
  context: OracleDaemonJobHandlerContext,
): Promise<void> {
  try {
    await connection.client.close();
  } finally {
    await closeRemoteChromeTarget(
      connection.host,
      connection.port,
      connection.targetId,
      (message) => {
        void context.log(message);
      },
    );
  }
}
