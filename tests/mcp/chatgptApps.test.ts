import { afterEach, describe, expect, test, vi } from "vitest";
import { ApprovalGrantAuthority, type ApprovalChallenge } from "../../src/browser/approvalToken.js";
import {
  registerChatgptAppsTools,
  type ChatgptAppsToolDependencies,
} from "../../src/mcp/tools/chatgptApps.js";
import type { ChatgptAppsDriver } from "../../src/browser/chatgpt/apps.js";

function fixture(): ChatgptAppsDriver {
  const drive = {
    appId: "drive",
    name: "Drive",
    revisionHash: "drive-rev-1",
  };
  const calendar = {
    appId: "calendar",
    name: "Calendar",
    revisionHash: "calendar-rev-1",
  };
  const driveConnector = {
    connectorId: "drive-files",
    appId: "drive",
    name: "Drive files",
    revisionHash: "drive-connector-rev-1",
    connectionState: "connected",
  };
  const calendarConnector = {
    connectorId: "calendar-events",
    appId: "calendar",
    name: "Calendar events",
    revisionHash: "calendar-connector-rev-1",
    connectionState: "connected",
  };
  return {
    allowlist: { appIds: ["drive"], connectorIds: ["drive-files"] },
    listApps: vi.fn(async () => [drive, calendar]),
    getApp: vi.fn(async (appId: string) => (appId === "calendar" ? calendar : drive)),
    listConnectors: vi.fn(async () => [driveConnector, calendarConnector]),
    getConnector: vi.fn(async (connectorId: string) =>
      connectorId === "calendar-events" ? calendarConnector : driveConnector,
    ),
    previewConnectorAction: vi.fn(async () => ({ external: true, summary: "Send" })),
    actionConnector: vi.fn(async () => ({ summary: "Sent", operationId: "operation-1" })),
  };
}

type ToolHandler = (input: unknown) => Promise<unknown>;

function handlers(dependencies: ChatgptAppsToolDependencies): Map<string, ToolHandler> {
  const values = new Map<string, ToolHandler>();
  const server = {
    registerTool: vi.fn((name: string, _config: unknown, handler: ToolHandler) =>
      values.set(name, handler),
    ),
  };
  registerChatgptAppsTools(server as never, dependencies);
  return values;
}
const authorities: ApprovalGrantAuthority[] = [];

function authority(): ApprovalGrantAuthority {
  const value = new ApprovalGrantAuthority({ dbPath: ":memory:" });
  authorities.push(value);
  return value;
}

afterEach(() => {
  for (const value of authorities.splice(0)) value.close();
});

describe("ChatGPT apps MCP allowlist", () => {
  test("uses trusted IDs when caller omits filters and intersects expansion attempts", async () => {
    const values = handlers({
      driver: fixture(),
      policy: { appIds: ["drive"], connectorIds: ["drive-files"] },
    });
    const list = values.get("chatgpt_apps_list");
    if (!list) throw new Error("missing list handler");
    await expect(list({})).resolves.toMatchObject({
      structuredContent: { state: "ok", apps: [{ appId: "drive" }] },
    });
    await expect(list({ appIds: ["drive", "calendar"], allowAll: true })).resolves.toMatchObject({
      structuredContent: { state: "ok", apps: [{ appId: "drive" }] },
    });
  });

  test("missing trusted policy fails closed for reads and external actions", async () => {
    const driver = fixture();
    const values = handlers({ driver });
    const list = values.get("chatgpt_apps_list");
    const action = values.get("chatgpt_connectors_action");
    if (!list || !action) throw new Error("missing apps handlers");
    await expect(list({})).resolves.toMatchObject({ structuredContent: { state: "ok", apps: [] } });
    await expect(
      action({ connectorId: "drive-files", action: "write", target: "file-1" }),
    ).resolves.toMatchObject({
      structuredContent: { state: "unsupported", code: "allowlist_rejected" },
    });
    expect(driver.getConnector).not.toHaveBeenCalled();
    expect(driver.previewConnectorAction).not.toHaveBeenCalled();
    expect(driver.actionConnector).not.toHaveBeenCalled();
  });

  test("trusted allowAll exposes observed records without caller filters", async () => {
    const values = handlers({ driver: fixture(), policy: { allowAll: true } });
    const list = values.get("chatgpt_apps_list");
    if (!list) throw new Error("missing list handler");
    await expect(list({})).resolves.toMatchObject({
      structuredContent: {
        state: "ok",
        apps: [{ appId: "drive" }, { appId: "calendar" }],
      },
    });
  });
  test("previews an approval challenge and requires a matching one-time grant for external actions", async () => {
    const driver = fixture();
    const grants = authority();
    const values = handlers({
      driver,
      policy: { appIds: ["drive"], connectorIds: ["drive-files"] },
      approvalAuthority: grants,
      principal: "principal-1",
      session: "session-1",
    });
    const action = values.get("chatgpt_connectors_action");
    if (!action) throw new Error("missing action handler");

    const previewResponse = await action({
      connectorId: "drive-files",
      action: "write",
      target: "file-1",
      dryRun: true,
    });
    const previewContent = (previewResponse as { structuredContent: Record<string, unknown> })
      .structuredContent;
    expect(previewContent).toMatchObject({
      state: "requires_action",
      dryRun: true,
      preview: { approvalChallenge: expect.any(Object) },
    });
    expect(previewContent).not.toHaveProperty("approvalGrant");
    const challenge = (previewContent.preview as { approvalChallenge?: ApprovalChallenge })
      .approvalChallenge;
    if (!challenge) throw new Error("expected approval challenge");

    const issued = grants.issueGrant(challenge, {
      confirmed: true,
      principal: "principal-1",
      session: "session-1",
    });
    expect(issued.state).toBe("issued");
    if (issued.state !== "issued") throw new Error("expected approval grant");
    expect(issued.grant).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await expect(
      action({
        connectorId: "drive-files",
        action: "write",
        target: "file-1",
        approvalChallenge: { ...challenge, target: "other-file" },
        approvalGrant: issued.grant,
      }),
    ).resolves.toMatchObject({
      structuredContent: { state: "requires_action", reason: "approval-grant-mismatch" },
    });
    expect(driver.actionConnector).not.toHaveBeenCalled();

    const committed = await action({
      connectorId: "drive-files",
      action: "write",
      target: "file-1",
      approvalChallenge: challenge,
      approvalGrant: issued.grant,
    });
    expect(committed).toMatchObject({
      structuredContent: { state: "ok", action: true, operationId: "operation-1" },
    });
    expect(committed).not.toHaveProperty("approvalGrant");

    await expect(
      action({
        connectorId: "drive-files",
        action: "write",
        target: "file-1",
        approvalChallenge: challenge,
        approvalGrant: issued.grant,
      }),
    ).resolves.toMatchObject({
      structuredContent: { state: "requires_action", reason: "approval-grant-replayed" },
    });
    expect(driver.actionConnector).toHaveBeenCalledTimes(1);
  });
});
