import { afterEach, describe, expect, test, vi } from "vitest";
import { ApprovalGrantAuthority } from "../../src/browser/approvalToken.js";
import {
  ChatgptAppsService,
  type AppConnectorPolicy,
  type ChatgptAppsDriver,
  type ChatgptAppsServiceOptions,
} from "../../src/browser/chatgpt/apps.js";

const trustedPolicy: AppConnectorPolicy = {
  appIds: ["drive"],
  connectorIds: ["drive-files"],
};
const authorities: ApprovalGrantAuthority[] = [];

function serviceFor(
  driver: ChatgptAppsDriver,
  policy: AppConnectorPolicy = trustedPolicy,
  options: Omit<ChatgptAppsServiceOptions, "policy"> = {},
): ChatgptAppsService {
  return new ChatgptAppsService(driver, { ...options, policy });
}

function authority(): ApprovalGrantAuthority {
  const value = new ApprovalGrantAuthority({ dbPath: ":memory:" });
  authorities.push(value);
  return value;
}

afterEach(() => {
  for (const value of authorities.splice(0)) value.close();
});

function fixtureDriver(overrides: Partial<ChatgptAppsDriver> = {}): ChatgptAppsDriver {
  const app = {
    appId: "drive",
    name: "Drive",
    revisionHash: "app-rev-1",
    capability: { observed: true, capabilities: ["read", "search", "write"] },
  };
  const connector = {
    connectorId: "drive-files",
    appId: "drive",
    name: "Drive files",
    revisionHash: "connector-rev-1",
    connectionState: "connected",
    capability: {
      observed: true,
      sourceSearch: "available",
      externalActions: "available",
      authorization: "available",
      capabilities: ["source_search", "external_action"],
    },
  };
  return {
    allowlist: { appIds: ["drive"], connectorIds: ["drive-files"] },
    listApps: vi.fn(async () => [app]),
    getApp: vi.fn(async () => app),
    listConnectors: vi.fn(async () => [connector]),
    getConnector: vi.fn(async () => connector),
    searchConnector: vi.fn(async () => ({
      matches: [{ sourceId: "s-1", title: "Public file", privateContent: "DO NOT RETURN" }],
    })),
    previewConnectorAction: vi.fn(async () => ({ external: true, summary: "Send a message" })),
    actionConnector: vi.fn(async () => ({ summary: "Sent", operationId: "op-1" })),
    authorizeConnector: vi.fn(async () => ({ summary: "Authorized" })),
    ...overrides,
  };
}
function observedDriver(overrides: Partial<ChatgptAppsDriver> = {}): ChatgptAppsDriver {
  const app = {
    appId: "drive",
    name: "Drive",
    revisionHash: "app-rev-1",
    capability: { observed: true, capabilities: ["read", "search", "write"] },
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
    revisionHash: "connector-rev-1",
    connectionState: "connected",
  };
  const calendarConnector = {
    connectorId: "calendar-events",
    appId: "calendar",
    name: "Calendar events",
    revisionHash: "calendar-connector-rev-1",
    connectionState: "connected",
  };
  return fixtureDriver({
    listApps: vi.fn(async () => [app, calendar]),
    getApp: vi.fn(async (appId: string) => (appId === "calendar" ? calendar : app)),
    listConnectors: vi.fn(async () => [driveConnector, calendarConnector]),
    getConnector: vi.fn(async (connectorId: string) =>
      connectorId === "calendar-events" ? calendarConnector : driveConnector,
    ),
    ...overrides,
  });
}

describe("ChatGPT apps and connectors", () => {
  test("lists observed records, gets a stable record, and rejects an unallowlisted ID", async () => {
    const driver = fixtureDriver();
    const service = serviceFor(driver);
    await expect(service.listApps()).resolves.toMatchObject({
      state: "ok",
      apps: [{ appId: "drive" }],
    });
    await expect(service.getConnector("drive-files")).resolves.toMatchObject({
      state: "ok",
      connector: { connectorId: "drive-files" },
    });
    await expect(service.getApp("calendar")).resolves.toMatchObject({
      state: "unsupported",
      code: "allowlist_rejected",
    });
  });

  test("read-only source search runs without approval and never invokes an external action", async () => {
    const driver = fixtureDriver();
    const service = serviceFor(driver);
    const result = await service.actionConnector({
      connectorId: "drive-files",
      action: "search",
      query: "roadmap",
    });
    expect(result).toMatchObject({
      state: "ok",
      readOnly: true,
      matches: [{ sourceId: "s-1", title: "Public file" }],
    });
    expect(driver.searchConnector).toHaveBeenCalledOnce();
    expect(driver.actionConnector).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("DO NOT RETURN");
  });

  test("external action previews an approval challenge, rejects mismatch, then commits with a matching grant", async () => {
    const driver = fixtureDriver();
    const grants = authority();
    const service = serviceFor(driver, trustedPolicy, { approvalAuthority: grants });
    const preview = await service.actionConnector({
      connectorId: "drive-files",
      action: "write",
      target: "file-1",
      dryRun: true,
    });
    expect(preview).toMatchObject({
      state: "requires_action",
      dryRun: true,
      preview: { external: true },
    });
    if (preview.state !== "requires_action" || !preview.approvalChallenge)
      throw new Error("expected approval challenge");
    await expect(
      service.actionConnector({
        connectorId: "drive-files",
        action: "write",
        target: "file-1",
        approvalChallenge: preview.approvalChallenge,
        approvalGrant: "A".repeat(43),
      }),
    ).resolves.toMatchObject({
      state: "requires_action",
      reason: "approval-grant-unknown",
    });
    const issued = grants.issueGrant(preview.approvalChallenge, { localOperator: true });
    expect(issued.state).toBe("issued");
    if (issued.state !== "issued") throw new Error("expected approval grant");
    await expect(
      service.actionConnector({
        connectorId: "drive-files",
        action: "write",
        target: "file-2",
        approvalChallenge: preview.approvalChallenge,
        approvalGrant: issued.grant,
      }),
    ).resolves.toMatchObject({
      state: "requires_action",
      reason: "approval-grant-mismatch",
    });
    expect(driver.actionConnector).not.toHaveBeenCalled();
    await expect(
      service.actionConnector({
        connectorId: "drive-files",
        action: "write",
        target: "file-1",
        approvalChallenge: preview.approvalChallenge,
        approvalGrant: issued.grant,
      }),
    ).resolves.toMatchObject({
      state: "ok",
      action: true,
      operationId: "op-1",
    });
    expect(driver.actionConnector).toHaveBeenCalledTimes(1);
  });

  test("binds grants to operation, target, and revision and detects revision drift before commit", async () => {
    const driver = fixtureDriver();
    const grants = authority();
    const service = serviceFor(driver, trustedPolicy, { approvalAuthority: grants });
    const records = [
      {
        connectorId: "drive-files",
        appId: "drive",
        name: "Drive files",
        revisionHash: "connector-rev-1",
        connectionState: "connected",
      },
      {
        connectorId: "drive-files",
        appId: "drive",
        name: "Drive files",
        revisionHash: "connector-rev-1",
        connectionState: "connected",
      },
      {
        connectorId: "drive-files",
        appId: "drive",
        name: "Drive files",
        revisionHash: "connector-rev-2",
        connectionState: "connected",
      },
    ];
    driver.getConnector = vi.fn(async () => records.shift() ?? records[0]);
    const preview = await service.actionConnector({
      connectorId: "drive-files",
      action: "write",
      target: "file-1",
      dryRun: true,
    });
    if (preview.state !== "requires_action" || !preview.approvalChallenge)
      throw new Error("expected approval challenge");
    const issued = grants.issueGrant(preview.approvalChallenge, { localOperator: true });
    if (issued.state !== "issued") throw new Error("expected approval grant");
    await expect(
      service.actionConnector({
        connectorId: "drive-files",
        action: "write",
        target: "file-1",
        approvalChallenge: preview.approvalChallenge,
        approvalGrant: issued.grant,
      }),
    ).resolves.toMatchObject({
      state: "conflict",
      reason: "revision-conflict",
      observedRevisionHash: "connector-rev-2",
    });
    expect(driver.actionConnector).not.toHaveBeenCalled();
  });

  test.each(["oauth", "account", "payment", "unknown"] as const)(
    "returns sanitized requires_action for %s dialog",
    async (kind) => {
      const driver = fixtureDriver({
        authorizeConnector: vi.fn(async () => ({ dialog: { kind, privateContent: "SECRET" } })),
      });
      const grants = authority();
      const service = serviceFor(driver, trustedPolicy, { approvalAuthority: grants });
      const preview = await service.authorizeConnector({
        connectorId: "drive-files",
        dryRun: true,
      });
      if (preview.state !== "requires_action" || !preview.approvalChallenge)
        throw new Error("expected approval challenge");
      const issued = grants.issueGrant(preview.approvalChallenge, { localOperator: true });
      if (issued.state !== "issued") throw new Error("expected approval grant");
      const result = await service.authorizeConnector({
        connectorId: "drive-files",
        approvalChallenge: preview.approvalChallenge,
        approvalGrant: issued.grant,
      });
      expect(result).toMatchObject({
        state: "requires_action",
        evidence: { kind, observed: true },
      });
      expect(JSON.stringify(result)).not.toContain("SECRET");
    },
  );

  test("types unsupported account UI and disconnects instead of pretending to succeed", async () => {
    const unsupported = fixtureDriver({
      authorizeConnector: vi.fn(async () => {
        throw new Error("unsupported account UI");
      }),
    });
    const grants = authority();
    const unsupportedService = serviceFor(unsupported, trustedPolicy, {
      approvalAuthority: grants,
    });
    const preview = await unsupportedService.authorizeConnector({
      connectorId: "drive-files",
      dryRun: true,
    });
    if (preview.state !== "requires_action" || !preview.approvalChallenge)
      throw new Error("expected approval challenge");
    const issued = grants.issueGrant(preview.approvalChallenge, { localOperator: true });
    if (issued.state !== "issued") throw new Error("expected approval grant");
    await expect(
      unsupportedService.authorizeConnector({
        connectorId: "drive-files",
        approvalChallenge: preview.approvalChallenge,
        approvalGrant: issued.grant,
      }),
    ).resolves.toMatchObject({ state: "unsupported", code: "unsupported_account_ui" });
    const disconnected = fixtureDriver({
      getConnector: vi.fn(async () => {
        throw new Error("browser disconnected");
      }),
    });
    await expect(serviceFor(disconnected).getConnector("drive-files")).resolves.toMatchObject({
      state: "disconnected",
      reason: "disconnected",
    });
  });
  test("fails closed when trusted policy is missing", async () => {
    const driver = observedDriver();
    await expect(new ChatgptAppsService(driver).listApps()).resolves.toMatchObject({
      state: "ok",
      apps: [],
    });
    await expect(new ChatgptAppsService(driver).getApp("drive")).resolves.toMatchObject({
      state: "unsupported",
      code: "allowlist_rejected",
    });
  });

  test("uses the trusted subset when the caller omits filters", async () => {
    const service = serviceFor(observedDriver(), trustedPolicy);
    await expect(service.listApps()).resolves.toMatchObject({
      state: "ok",
      apps: [{ appId: "drive" }],
    });
    await expect(service.listConnectors()).resolves.toMatchObject({
      state: "ok",
      connectors: [{ connectorId: "drive-files" }],
    });
  });

  test("intersects mixed caller filters and hides expansion attempts", async () => {
    const driver = observedDriver();
    const service = serviceFor(driver, trustedPolicy, {
      allowlist: {
        appIds: ["drive", "calendar"],
        connectorIds: ["drive-files", "calendar-events"],
      },
    });
    await expect(service.listApps()).resolves.toMatchObject({
      state: "ok",
      apps: [{ appId: "drive" }],
    });
    await expect(service.listConnectors()).resolves.toMatchObject({
      state: "ok",
      connectors: [{ connectorId: "drive-files" }],
    });
    await expect(service.getApp("calendar")).resolves.toMatchObject({
      state: "unsupported",
      code: "allowlist_rejected",
    });
    await expect(service.getConnector("calendar-events")).resolves.toMatchObject({
      state: "unsupported",
      code: "allowlist_rejected",
    });
    expect(driver.getApp).not.toHaveBeenCalledWith("calendar");
    expect(driver.getConnector).not.toHaveBeenCalledWith("calendar-events");
  });

  test("empty trusted IDs deny all and external actions make zero driver calls", async () => {
    const driver = observedDriver();
    const service = serviceFor(driver, { appIds: [], connectorIds: [] });
    await expect(service.listApps()).resolves.toMatchObject({ state: "ok", apps: [] });
    await expect(service.listConnectors()).resolves.toMatchObject({ state: "ok", connectors: [] });
    await expect(
      service.actionConnector({ connectorId: "drive-files", action: "write", target: "file-1" }),
    ).resolves.toMatchObject({ state: "unsupported", code: "allowlist_rejected" });
    expect(driver.getConnector).not.toHaveBeenCalled();
    expect(driver.previewConnectorAction).not.toHaveBeenCalled();
    expect(driver.actionConnector).not.toHaveBeenCalled();
  });

  test("requires explicit trusted allowAll to expose every observed ID", async () => {
    const driver = observedDriver();
    const service = serviceFor(driver, { allowAll: true });
    await expect(service.listApps()).resolves.toMatchObject({
      state: "ok",
      apps: [{ appId: "drive" }, { appId: "calendar" }],
    });
    await expect(service.listConnectors()).resolves.toMatchObject({
      state: "ok",
      connectors: [{ connectorId: "drive-files" }, { connectorId: "calendar-events" }],
    });
  });
});
