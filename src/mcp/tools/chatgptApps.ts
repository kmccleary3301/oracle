import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApprovalGrantAuthority } from "../../browser/approvalToken.js";
import {
  ChatgptAppsService,
  type AppConnectorPolicy,
  type ChatgptAppsAllowlist,
  type ChatgptAppsDriver,
  type ChatgptConnectorActionInput,
  type ChatgptConnectorAuthorizeInput,
} from "../../browser/chatgpt/apps.js";

const appId = z.string().trim().min(1).max(240);
const connectorId = z.string().trim().min(1).max(240);
const revisionHash = z.string().trim().min(1).max(240);
const approvalChallenge = z.object({
  operation: z.string().min(1),
  target: z.string().min(1),
  revision: z.string().min(1),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  expiry: z.number().int().positive(),
});
const approvalGrant = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const boundedScope = z.string().trim().min(1).max(120);
const boundedPayload = z
  .record(z.string().max(80), z.string().max(2_000))
  .refine((value) => Object.keys(value).length <= 32);

const appAllowlistShape = {
  appIds: z.array(appId).max(100).optional(),
  connectorIds: z.array(connectorId).max(100).optional(),
} satisfies z.ZodRawShape;

const appShape = z.object({
  appId,
  name: z.string().max(200),
  revisionHash,
  connected: z.boolean().optional(),
  capability: z
    .object({
      observed: z.literal(true),
      pageIdentity: z.enum(["chatgpt_app", "auth", "challenge", "other", "unknown"]).optional(),
      loginState: z
        .enum(["logged_in", "login_required", "challenge_required", "unknown"])
        .optional(),
      capabilities: z.array(z.string().max(40)).max(16),
      reason: z.string().max(120).optional(),
    })
    .optional(),
});
const connectorShape = z.object({
  connectorId,
  appId,
  name: z.string().max(200),
  revisionHash,
  connectionState: z.enum(["connected", "disconnected", "available", "unknown"]),
  capability: z
    .object({
      observed: z.literal(true),
      sourceSearch: z.enum(["available", "unavailable", "unknown"]),
      externalActions: z.enum(["available", "unavailable", "unknown"]),
      authorization: z.enum(["available", "unavailable", "unknown"]),
      capabilities: z.array(z.string().max(40)).max(16),
      reason: z.string().max(120).optional(),
    })
    .optional(),
});
const evidenceShape = z.object({
  kind: z.enum(["oauth", "account", "payment", "unknown"]),
  observed: z.literal(true),
  code: z.enum(["oauth_required", "account_required", "payment_required", "unknown_dialog"]),
});
const previewShape = z.object({
  connectorId,
  appId,
  operation: z.string().max(100),
  target: z.string().max(240),
  revisionHash,
  approvalChallenge,
  external: z.boolean(),
  readOnly: z.boolean(),
  summary: z.string().max(240),
});
const resultBaseShape = {
  state: z.enum(["ok", "unsupported", "requires_action", "conflict", "disconnected"]),
  appId: appId.optional(),
  connectorId: connectorId.optional(),
  revisionHash: revisionHash.optional(),
  approvalChallenge: approvalChallenge.optional(),
  reason: z.string().max(160).optional(),
  code: z.string().max(80).optional(),
  evidence: evidenceShape.optional(),
};
const listAppsOutputShape = {
  ...resultBaseShape,
  apps: z.array(appShape).max(100),
} satisfies z.ZodRawShape;
const getAppOutputShape = {
  ...resultBaseShape,
  app: appShape.optional(),
} satisfies z.ZodRawShape;
const listConnectorsOutputShape = {
  ...resultBaseShape,
  connectors: z.array(connectorShape).max(100),
} satisfies z.ZodRawShape;
const getConnectorOutputShape = {
  ...resultBaseShape,
  connector: connectorShape.optional(),
} satisfies z.ZodRawShape;
const actionOutputShape = {
  ...resultBaseShape,
  dryRun: z.boolean().optional(),
  operation: z.string().max(100).optional(),
  target: z.string().max(240).optional(),
  action: z.boolean().optional(),
  summary: z.string().max(240).optional(),
  operationId: z.string().max(200).optional(),
  preview: previewShape.optional(),
  query: z.string().max(500).optional(),
  readOnly: z.boolean().optional(),
  matches: z
    .array(
      z.object({
        sourceId: z.string().max(240),
        title: z.string().max(240),
        url: z.string().max(1_000).optional(),
        snippet: z.string().max(240).optional(),
      }),
    )
    .max(50)
    .optional(),
} satisfies z.ZodRawShape;
export interface ChatgptAppsToolDependencies {
  driver?: ChatgptAppsDriver;
  /** Trusted server-owned policy; omission fails closed. */
  policy?: AppConnectorPolicy;
  approvalAuthority?: ApprovalGrantAuthority;
  principal?: string;
  session?: string;
}

function unavailableDriver(): ChatgptAppsDriver {
  const unavailable = async (): Promise<never> => {
    throw new Error("apps-driver-unavailable");
  };
  return {
    listApps: unavailable,
    getApp: unavailable,
    listConnectors: unavailable,
    getConnector: unavailable,
  };
}

function service(
  dependencies: ChatgptAppsToolDependencies,
  allowlist?: ChatgptAppsAllowlist,
): ChatgptAppsService {
  return new ChatgptAppsService(dependencies.driver ?? unavailableDriver(), {
    policy: dependencies.policy,
    allowlist,
    approvalAuthority: dependencies.approvalAuthority,
    principal: dependencies.principal,
    session: dependencies.session,
  });
}

function text(state: string, noun: string): { type: "text"; text: string }[] {
  return [{ type: "text", text: `${noun}: ${state}.` }];
}

export function registerChatgptAppsTools(
  server: McpServer,
  dependencies: ChatgptAppsToolDependencies = {},
): void {
  server.registerTool(
    "chatgpt_apps_list",
    {
      title: "List ChatGPT apps",
      description:
        "List allowlisted ChatGPT apps using observed stable IDs and capability evidence.",
      inputSchema: appAllowlistShape,
      outputSchema: listAppsOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(appAllowlistShape).parse(input);
      const result = await service(dependencies, parsed).listApps();
      return { structuredContent: { ...result }, content: text(result.state, "ChatGPT apps") };
    },
  );

  server.registerTool(
    "chatgpt_apps_get",
    {
      title: "Get ChatGPT app",
      description: "Read one allowlisted ChatGPT app by stable observed ID.",
      inputSchema: { ...appAllowlistShape, appId },
      outputSchema: getAppOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object({ ...appAllowlistShape, appId }).parse(input);
      const result = await service(dependencies, parsed).getApp(parsed.appId);
      return { structuredContent: { ...result }, content: text(result.state, "ChatGPT app") };
    },
  );

  server.registerTool(
    "chatgpt_connectors_list",
    {
      title: "List ChatGPT connectors",
      description:
        "List allowlisted ChatGPT connectors using observed stable IDs and capability evidence.",
      inputSchema: appAllowlistShape,
      outputSchema: listConnectorsOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object(appAllowlistShape).parse(input);
      const result = await service(dependencies, parsed).listConnectors();
      return {
        structuredContent: { ...result },
        content: text(result.state, "ChatGPT connectors"),
      };
    },
  );

  server.registerTool(
    "chatgpt_connectors_get",
    {
      title: "Get ChatGPT connector",
      description: "Read one allowlisted ChatGPT connector by stable observed ID.",
      inputSchema: { ...appAllowlistShape, connectorId },
      outputSchema: getConnectorOutputShape,
    },
    async (input: unknown) => {
      const parsed = z.object({ ...appAllowlistShape, connectorId }).parse(input);
      const result = await service(dependencies, parsed).getConnector(parsed.connectorId);
      return { structuredContent: { ...result }, content: text(result.state, "ChatGPT connector") };
    },
  );

  server.registerTool(
    "chatgpt_connectors_authorize",
    {
      title: "Authorize ChatGPT connector",
      description:
        "Preview or explicitly approve connector authorization; OAuth and account dialogs remain requires_action.",
      inputSchema: {
        ...appAllowlistShape,
        connectorId,
        scopes: z.array(boundedScope).max(32).optional(),
        expectedRevisionHash: revisionHash.optional(),
        dryRun: z.boolean().optional(),
        approvalChallenge: approvalChallenge.optional(),
        approvalGrant: approvalGrant.optional(),
      },
      outputSchema: actionOutputShape,
    },
    async (input: unknown) => {
      const parsed = z
        .object({
          ...appAllowlistShape,
          connectorId,
          scopes: z.array(boundedScope).max(32).optional(),
          expectedRevisionHash: revisionHash.optional(),
          dryRun: z.boolean().optional(),
          approvalChallenge: approvalChallenge.optional(),
          approvalGrant: approvalGrant.optional(),
        })
        .parse(input);
      const operation: ChatgptConnectorAuthorizeInput = parsed;
      const result = await service(dependencies, parsed).authorizeConnector(operation);
      return {
        structuredContent: { ...result },
        content: text(result.state, "ChatGPT connector authorization"),
      };
    },
  );

  server.registerTool(
    "chatgpt_connectors_action",
    {
      title: "Run ChatGPT connector action",
      description:
        "Search connector sources automatically when read-only; external writes, actions, and shares require exact approval.",
      inputSchema: {
        ...appAllowlistShape,
        connectorId,
        action: z.string().trim().min(1).max(80),
        target: z.string().trim().max(240).optional(),
        query: z.string().trim().max(500).optional(),
        payload: boundedPayload.optional(),
        expectedRevisionHash: revisionHash.optional(),
        dryRun: z.boolean().optional(),
        approvalChallenge: approvalChallenge.optional(),
        approvalGrant: approvalGrant.optional(),
      },
      outputSchema: actionOutputShape,
    },
    async (input: unknown) => {
      const parsed = z
        .object({
          ...appAllowlistShape,
          connectorId,
          action: z.string().trim().min(1).max(80),
          target: z.string().trim().max(240).optional(),
          query: z.string().trim().max(500).optional(),
          payload: boundedPayload.optional(),
          expectedRevisionHash: revisionHash.optional(),
          dryRun: z.boolean().optional(),
          approvalChallenge: approvalChallenge.optional(),
          approvalGrant: approvalGrant.optional(),
        })
        .parse(input);
      const operation: ChatgptConnectorActionInput = parsed;
      const result = await service(dependencies, parsed).actionConnector(operation);
      return {
        structuredContent: { ...result },
        content: text(result.state, "ChatGPT connector action"),
      };
    },
  );
}
