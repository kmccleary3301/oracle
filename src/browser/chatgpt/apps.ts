import {
  ApprovalGrantAuthority,
  bindApprovalChallenge,
  createApprovalChallenge,
  type ApprovalChallenge,
} from "../approvalToken.js";
import type {
  AppConnectorPolicy,
  ChatgptAppCapability,
  ChatgptAppCapabilityEvidence,
  ChatgptAppGetResult,
  ChatgptAppRecord,
  ChatgptAppsAllowlist,
  ChatgptAppsConflictResult,
  ChatgptAppsDriver,
  ChatgptAppsListResult,
  ChatgptAppsOperationResult,
  ChatgptAppsResultBase,
  ChatgptAppsUnsupportedResult,
  ChatgptConnectorActionInput,
  ChatgptConnectorActionPreview,
  ChatgptConnectorActionResult,
  ChatgptConnectorCapability,
  ChatgptConnectorCapabilityEvidence,
  ChatgptConnectorDialogEvidence,
  ChatgptConnectorDialogKind,
  ChatgptConnectorGetResult,
  ChatgptConnectorRecord,
  ChatgptConnectorSearchResult,
  ChatgptConnectorSourceMatch,
  ChatgptConnectorAuthorizeInput,
  ChatgptConnectorsListResult,
} from "./appsTypes.js";

export * from "./appsTypes.js";

export const CONNECTOR_APPROVAL_OPERATIONS = {
  authorize: "connector.authorize",
  action: "connector.action",
} as const;

type ConnectorApprovalOperation =
  (typeof CONNECTOR_APPROVAL_OPERATIONS)[keyof typeof CONNECTOR_APPROVAL_OPERATIONS];

const APP_CAPABILITIES: readonly ChatgptAppCapability[] = [
  "search",
  "read",
  "sync",
  "write",
  "action",
  "share",
  "authorize",
];
const CONNECTOR_CAPABILITIES: readonly ChatgptConnectorCapability[] = [
  ...APP_CAPABILITIES,
  "source_search",
  "external_action",
];
const DIALOG_KINDS: readonly ChatgptConnectorDialogKind[] = [
  "oauth",
  "account",
  "payment",
  "unknown",
];
export interface ChatgptAppsServiceOptions {
  /** Server-owned policy; absence intentionally denies every ID. */
  policy?: AppConnectorPolicy;
  /** Untrusted per-call filter supplied by the MCP caller. */
  allowlist?: ChatgptAppsAllowlist;
  approvalAuthority?: ApprovalGrantAuthority;
  principal?: string;
  session?: string;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function id(value: unknown, label: string): string {
  if (!nonEmpty(value)) throw new Error(`${label} is missing from the observed response.`);
  return value.trim().slice(0, 240);
}

function revision(value: unknown): string {
  return id(value, "revisionHash");
}

function boundedText(value: unknown, limit: number, fallback: string): string {
  return nonEmpty(value) ? value.trim().slice(0, limit) : fallback;
}

function safeReason(value: unknown): string | undefined {
  if (!nonEmpty(value)) return undefined;
  const reason = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, "-")
    .slice(0, 120);
  return reason || undefined;
}

function safeCapabilities(value: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (entry): entry is string => typeof entry === "string" && allowed.includes(entry),
      ),
    ),
  ].slice(0, 16);
}

function safeAppCapability(value: unknown): ChatgptAppCapabilityEvidence | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const capabilities = safeCapabilities(
    input.capabilities,
    APP_CAPABILITIES,
  ) as ChatgptAppCapability[];
  const pageIdentity = ["chatgpt_app", "auth", "challenge", "other", "unknown"].includes(
    String(input.pageIdentity),
  )
    ? (String(input.pageIdentity) as ChatgptAppCapabilityEvidence["pageIdentity"])
    : undefined;
  const loginState = ["logged_in", "login_required", "challenge_required", "unknown"].includes(
    String(input.loginState),
  )
    ? (String(input.loginState) as ChatgptAppCapabilityEvidence["loginState"])
    : undefined;
  return {
    observed: true,
    ...(pageIdentity ? { pageIdentity } : {}),
    ...(loginState ? { loginState } : {}),
    capabilities,
    ...(safeReason(input.reason) ? { reason: safeReason(input.reason) } : {}),
  };
}

function safeConnectorCapability(value: unknown): ChatgptConnectorCapabilityEvidence | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const state = (key: string): "available" | "unavailable" | "unknown" =>
    ["available", "unavailable", "unknown"].includes(String(input[key]))
      ? (String(input[key]) as "available" | "unavailable" | "unknown")
      : "unknown";
  return {
    observed: true,
    sourceSearch: state("sourceSearch"),
    externalActions: state("externalActions"),
    authorization: state("authorization"),
    capabilities: safeCapabilities(
      input.capabilities,
      CONNECTOR_CAPABILITIES,
    ) as ChatgptConnectorCapability[],
    ...(safeReason(input.reason) ? { reason: safeReason(input.reason) } : {}),
  };
}

function safeApp(value: unknown): ChatgptAppRecord {
  if (!value || typeof value !== "object") throw new Error("app-invalid-observation");
  const input = value as Record<string, unknown>;
  const appId = id(input.appId ?? input.id, "appId");
  return {
    appId,
    name: boundedText(input.name ?? input.label, 200, appId),
    revisionHash: revision(input.revisionHash ?? input.revision),
    ...(typeof input.connected === "boolean" ? { connected: input.connected } : {}),
    ...(input.capability || input.capabilities
      ? { capability: safeAppCapability(input.capability ?? { capabilities: input.capabilities }) }
      : {}),
  };
}

function safeConnector(value: unknown): ChatgptConnectorRecord {
  if (!value || typeof value !== "object") throw new Error("connector-invalid-observation");
  const input = value as Record<string, unknown>;
  const connectorId = id(input.connectorId ?? input.id, "connectorId");
  const appId = id(input.appId ?? input.applicationId, "appId");
  const state = ["connected", "disconnected", "available", "unknown"].includes(
    String(input.connectionState ?? input.state),
  )
    ? (String(input.connectionState ?? input.state) as ChatgptConnectorRecord["connectionState"])
    : "unknown";
  return {
    connectorId,
    appId,
    name: boundedText(input.name ?? input.label, 200, connectorId),
    revisionHash: revision(input.revisionHash ?? input.revision),
    connectionState: state,
    ...(input.capability || input.capabilities
      ? {
          capability: safeConnectorCapability(
            input.capability ?? { capabilities: input.capabilities },
          ),
        }
      : {}),
  };
}

function normalizeIds(values: readonly string[] | undefined): Set<string> {
  return new Set(
    (Array.isArray(values) ? values : []).filter(nonEmpty).map((value) => value.trim()),
  );
}

function intersect(
  trusted: Set<string> | undefined,
  caller: Set<string> | undefined,
): Set<string> | undefined {
  if (!trusted) return caller;
  if (!caller) return trusted;
  return new Set([...trusted].filter((value) => caller.has(value)));
}

function normalizeAllowlist(
  policy?: AppConnectorPolicy,
  caller?: ChatgptAppsAllowlist,
): {
  appIds?: Set<string>;
  connectorIds?: Set<string>;
} {
  const trustedAppIds = policy?.allowAll === true ? undefined : normalizeIds(policy?.appIds);
  const trustedConnectorIds =
    policy?.allowAll === true ? undefined : normalizeIds(policy?.connectorIds);
  return {
    appIds: intersect(
      trustedAppIds,
      caller?.appIds === undefined ? undefined : normalizeIds(caller.appIds),
    ),
    connectorIds: intersect(
      trustedConnectorIds,
      caller?.connectorIds === undefined ? undefined : normalizeIds(caller.connectorIds),
    ),
  };
}

function allowlisted(value: string, list: Set<string> | undefined): boolean {
  return list ? list.has(value) : true;
}

function unsupported(
  reason: string,
  extra: Omit<ChatgptAppsResultBase, "state"> = {},
): ChatgptAppsUnsupportedResult {
  return { state: "unsupported", ...extra, reason };
}

function disconnected(
  connectorId?: string,
): ChatgptAppsResultBase & { state: "disconnected"; reason: string } {
  return { state: "disconnected", ...(connectorId ? { connectorId } : {}), reason: "disconnected" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyFailure(
  error: unknown,
  target?: { appId?: string; connectorId?: string },
): ChatgptAppsOperationResult {
  const message = errorMessage(error).toLowerCase();
  const base: Omit<ChatgptAppsResultBase, "state"> = { ...target };
  if (/disconnect|offline|closed|detached|not connected/.test(message))
    return disconnected(target?.connectorId);
  if (/unsupported account ui|account ui unsupported|unsupported.*account/.test(message)) {
    return unsupported("unsupported-account-ui", { ...base, code: "unsupported_account_ui" });
  }
  const dialog = dialogEvidence(error);
  if (dialog)
    return {
      ...base,
      state: "requires_action",
      reason: dialog.kind === "oauth" ? "oauth-required" : `${dialog.kind}-required`,
      code: dialog.code,
      dryRun: false,
      evidence: dialog,
    };
  if (/unsupported|not implemented|unavailable|not found/.test(message)) {
    return unsupported("unsupported-action", { ...base, code: "unsupported_action" });
  }
  return {
    ...base,
    state: "requires_action",
    reason: "connector-action-unavailable",
    dryRun: false,
  };
}

function dialogEvidence(value: unknown): ChatgptConnectorDialogEvidence | undefined {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  const raw =
    input?.dialog && typeof input.dialog === "object"
      ? (input.dialog as Record<string, unknown>)
      : input;
  const kind =
    raw && DIALOG_KINDS.includes(String(raw.kind) as ChatgptConnectorDialogKind)
      ? (String(raw.kind) as ChatgptConnectorDialogKind)
      : undefined;
  if (!kind) {
    const message = errorMessage(value).toLowerCase();
    const inferred = DIALOG_KINDS.find((candidate) => message.includes(candidate));
    if (!inferred) return undefined;
    return dialogEvidence({ kind: inferred });
  }
  const code =
    kind === "oauth"
      ? "oauth_required"
      : kind === "account"
        ? "account_required"
        : kind === "payment"
          ? "payment_required"
          : "unknown_dialog";
  return { kind, observed: true, code };
}

function targetForAction(connectorId: string, action: string, target: string): string {
  return `${connectorId}:${action}:${target}`;
}

function challengeFor(
  operation: ConnectorApprovalOperation,
  target: string,
  revisionHash: string,
  payload?: unknown,
): ApprovalChallenge {
  return createApprovalChallenge({
    operation,
    target,
    revision: revisionHash,
    payload,
    expiry: Date.now() + 5 * 60 * 1000,
  });
}

function conflict(
  connectorId: string,
  expectedRevisionHash: string | undefined,
  observedRevisionHash?: string,
): ChatgptAppsConflictResult {
  return {
    state: "conflict",
    connectorId,
    reason: "revision-conflict",
    code: "revision_conflict",
    expectedRevisionHash,
    observedRevisionHash,
    revisionHash: observedRevisionHash,
  };
}

function actionReadOnly(action: string, input: ChatgptConnectorActionInput): boolean {
  return (
    action === "search" ||
    action === "read" ||
    (action === "source_search" && input.dryRun !== true)
  );
}

function safeSummary(value: unknown): string | undefined {
  return nonEmpty(value)
    ? value
        .trim()
        .replace(/[\r\n\t]+/g, " ")
        .slice(0, 240)
    : undefined;
}

function safeSourceMatches(value: unknown): ChatgptConnectorSourceMatch[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const input = item as Record<string, unknown>;
      try {
        const sourceId = id(input.sourceId ?? input.id, "sourceId");
        const title = boundedText(input.title ?? input.name, 240, sourceId);
        const url = nonEmpty(input.url) ? input.url.trim().slice(0, 1_000) : undefined;
        const snippet = safeSummary(input.snippet ?? input.summary);
        return [{ sourceId, title, ...(url ? { url } : {}), ...(snippet ? { snippet } : {}) }];
      } catch {
        return [];
      }
    })
    .slice(0, 50);
}

function safePreview(
  connector: ChatgptConnectorRecord,
  operation: string,
  target: string,
  challenge: ApprovalChallenge,
  value: unknown,
): ChatgptConnectorActionPreview {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    connectorId: connector.connectorId,
    appId: connector.appId,
    operation,
    target,
    revisionHash: connector.revisionHash,
    approvalChallenge: challenge,
    external: input.external !== false,
    readOnly: false,
    summary: safeSummary(input.summary) ?? "External connector action requires confirmation.",
  };
}

function scopes(input: ChatgptConnectorAuthorizeInput): readonly string[] {
  return [
    ...new Set((input.scopes ?? []).filter(nonEmpty).map((scope) => scope.trim().slice(0, 120))),
  ].slice(0, 32);
}

export class ChatgptAppsService {
  private readonly policy?: AppConnectorPolicy;
  private readonly allowlist?: ChatgptAppsAllowlist;
  private readonly approvalAuthority?: ApprovalGrantAuthority;
  private readonly principal?: string;
  private readonly session?: string;

  constructor(
    private readonly driver: ChatgptAppsDriver,
    options: ChatgptAppsServiceOptions = {},
  ) {
    this.policy = options.policy;
    this.allowlist = options.allowlist;
    this.approvalAuthority = options.approvalAuthority;
    this.principal = options.principal;
    this.session = options.session;
  }
  async listApps(): Promise<ChatgptAppsListResult | ChatgptAppsResultBase> {
    try {
      const lists = normalizeAllowlist(this.policy, this.allowlist);
      const apps = (await this.driver.listApps()).flatMap((item) => {
        try {
          const app = safeApp(item);
          return allowlisted(app.appId, lists.appIds) ? [app] : [];
        } catch {
          return [];
        }
      });
      return { state: "ok", apps };
    } catch (error) {
      return classifyFailure(error);
    }
  }

  async getApp(appIdInput: string): Promise<ChatgptAppGetResult | ChatgptAppsResultBase> {
    let appId = "";
    try {
      appId = id(appIdInput, "appId");
      const lists = normalizeAllowlist(this.policy, this.allowlist);
      if (!allowlisted(appId, lists.appIds))
        return unsupported("allowlist-rejected", { appId, code: "allowlist_rejected" });
      const app = safeApp(await this.driver.getApp(appId));
      if (app.appId !== appId)
        return unsupported("app-identity-mismatch", { appId, code: "invalid_observation" });
      return { state: "ok", appId, revisionHash: app.revisionHash, app };
    } catch (error) {
      return classifyFailure(error, { appId: appId || undefined });
    }
  }

  async listConnectors(): Promise<ChatgptConnectorsListResult | ChatgptAppsResultBase> {
    try {
      const lists = normalizeAllowlist(this.policy, this.allowlist);
      const connectors = (await this.driver.listConnectors()).flatMap((item) => {
        try {
          const connector = safeConnector(item);
          return allowlisted(connector.connectorId, lists.connectorIds) &&
            allowlisted(connector.appId, lists.appIds)
            ? [connector]
            : [];
        } catch {
          return [];
        }
      });
      return { state: "ok", connectors };
    } catch (error) {
      return classifyFailure(error);
    }
  }

  async getConnector(
    connectorIdInput: string,
  ): Promise<ChatgptConnectorGetResult | ChatgptAppsResultBase> {
    let connectorId = "";
    try {
      connectorId = id(connectorIdInput, "connectorId");
      const lists = normalizeAllowlist(this.policy, this.allowlist);
      if (!allowlisted(connectorId, lists.connectorIds))
        return unsupported("allowlist-rejected", { connectorId, code: "allowlist_rejected" });
      const connector = safeConnector(await this.driver.getConnector(connectorId));
      if (connector.connectorId !== connectorId || !allowlisted(connector.appId, lists.appIds)) {
        return unsupported("connector-identity-not-allowlisted", {
          connectorId,
          code: "allowlist_rejected",
        });
      }
      return { state: "ok", connectorId, revisionHash: connector.revisionHash, connector };
    } catch (error) {
      return classifyFailure(error, { connectorId: connectorId || undefined });
    }
  }

  async authorizeConnector(
    input: ChatgptConnectorAuthorizeInput,
  ): Promise<ChatgptAppsOperationResult> {
    let connectorId = "";
    try {
      connectorId = id(input.connectorId, "connectorId");
      const lists = normalizeAllowlist(this.policy, this.allowlist);
      if (!allowlisted(connectorId, lists.connectorIds))
        return unsupported("allowlist-rejected", { connectorId, code: "allowlist_rejected" });
      const before = safeConnector(await this.driver.getConnector(connectorId));
      if (before.connectorId !== connectorId || !allowlisted(before.appId, lists.appIds))
        return unsupported("connector-identity-not-allowlisted", {
          connectorId,
          code: "allowlist_rejected",
        });
      if (input.expectedRevisionHash && input.expectedRevisionHash !== before.revisionHash)
        return conflict(connectorId, input.expectedRevisionHash, before.revisionHash);
      const challenge = bindApprovalChallenge(
        challengeFor(CONNECTOR_APPROVAL_OPERATIONS.authorize, connectorId, before.revisionHash, {
          connectorId,
          scopes: scopes(input),
        }),
        input.approvalChallenge,
      );
      const preview: ChatgptConnectorActionPreview = {
        connectorId,
        appId: before.appId,
        operation: CONNECTOR_APPROVAL_OPERATIONS.authorize,
        target: connectorId,
        revisionHash: before.revisionHash,
        approvalChallenge: challenge,
        external: true,
        readOnly: false,
        summary: "Connector authorization requires confirmation.",
      };
      if (input.dryRun)
        return {
          state: "requires_action",
          connectorId,
          revisionHash: before.revisionHash,
          reason: "approval-required",
          code: "approval_required",
          dryRun: true,
          approvalChallenge: challenge,
          preview,
        };
      if (!this.approvalAuthority)
        return {
          state: "requires_action",
          connectorId,
          revisionHash: before.revisionHash,
          reason: "approval-authority-unavailable",
          code: "approval_required",
          dryRun: false,
          approvalChallenge: challenge,
          preview,
        };
      const consumed = this.approvalAuthority.consumeGrant(input.approvalGrant, challenge, {
        principal: this.principal,
        session: this.session,
      });
      if (consumed.state !== "consumed")
        return {
          state: "requires_action",
          connectorId,
          revisionHash: before.revisionHash,
          reason: consumed.reason,
          code:
            consumed.reason === "approval-grant-mismatch"
              ? "approval_grant_mismatch"
              : "approval_required",
          dryRun: false,
          approvalChallenge: challenge,
          preview,
        };
      if (!this.driver.authorizeConnector)
        return unsupported("unsupported-authorization", {
          connectorId,
          revisionHash: before.revisionHash,
          code: "unsupported_action",
        });
      const current = safeConnector(await this.driver.getConnector(connectorId));
      if (current.connectorId !== connectorId)
        return conflict(connectorId, before.revisionHash, current.revisionHash);
      if (current.revisionHash !== before.revisionHash)
        return conflict(connectorId, before.revisionHash, current.revisionHash);
      const result = await this.driver.authorizeConnector({
        connectorId,
        scopes: scopes(input),
        expectedRevisionHash: before.revisionHash,
      });
      const dialog = dialogEvidence(result);
      if (dialog)
        return {
          state: "requires_action",
          connectorId,
          revisionHash: before.revisionHash,
          reason: `${dialog.kind}-required`,
          code: dialog.code,
          dryRun: false,
          approvalChallenge: challenge,
          evidence: dialog,
          preview,
        };
      const after = safeConnector(await this.driver.getConnector(connectorId));
      if (after.connectorId !== connectorId)
        return conflict(connectorId, before.revisionHash, after.revisionHash);
      return {
        state: "ok",
        connectorId,
        revisionHash: after.revisionHash,
        operation: CONNECTOR_APPROVAL_OPERATIONS.authorize,
        target: connectorId,
        action: true,
        summary:
          safeSummary((result as Record<string, unknown> | null)?.summary) ??
          "Connector authorized.",
      } as ChatgptConnectorActionResult;
    } catch (error) {
      return classifyFailure(error, { connectorId: connectorId || undefined });
    }
  }

  async actionConnector(input: ChatgptConnectorActionInput): Promise<ChatgptAppsOperationResult> {
    let connectorId = "";
    try {
      connectorId = id(input.connectorId, "connectorId");
      const action = id(input.action, "action").toLowerCase();
      const target = boundedText(input.target, 240, connectorId);
      const lists = normalizeAllowlist(this.policy, this.allowlist);
      if (!allowlisted(connectorId, lists.connectorIds))
        return unsupported("allowlist-rejected", { connectorId, code: "allowlist_rejected" });
      const before = safeConnector(await this.driver.getConnector(connectorId));
      if (before.connectorId !== connectorId || !allowlisted(before.appId, lists.appIds))
        return unsupported("connector-identity-not-allowlisted", {
          connectorId,
          code: "allowlist_rejected",
        });
      if (input.expectedRevisionHash && input.expectedRevisionHash !== before.revisionHash)
        return conflict(connectorId, input.expectedRevisionHash, before.revisionHash);
      const readOnly = actionReadOnly(action, input);
      const capability = before.capability;
      if (
        readOnly &&
        action === "search" &&
        capability &&
        capability.sourceSearch === "unavailable"
      )
        return unsupported("unsupported-action", { connectorId, code: "unsupported_action" });
      if (!readOnly && capability && capability.externalActions === "unavailable")
        return unsupported("unsupported-action", { connectorId, code: "unsupported_action" });
      if (readOnly) {
        if (action === "search" && !this.driver.searchConnector)
          return unsupported("unsupported-action", { connectorId, code: "unsupported_action" });
        const result =
          action === "search"
            ? await this.driver.searchConnector!({
                connectorId,
                appId: before.appId,
                query: boundedText(input.query, 500, target),
                expectedRevisionHash: before.revisionHash,
              })
            : await this.driver.actionConnector?.({
                connectorId,
                appId: before.appId,
                action,
                target,
                query: input.query,
                payload: undefined,
                expectedRevisionHash: before.revisionHash,
              });
        const dialog = dialogEvidence(result);
        if (dialog)
          return {
            state: "requires_action",
            connectorId,
            revisionHash: before.revisionHash,
            reason: `${dialog.kind}-required`,
            code: dialog.code,
            dryRun: false,
            evidence: dialog,
          };
        const output =
          result && typeof result === "object" ? (result as Record<string, unknown>) : {};
        const matches = safeSourceMatches(output.matches ?? output.sources ?? output.results);
        return {
          state: "ok",
          connectorId,
          revisionHash: before.revisionHash,
          query: boundedText(input.query, 500, target),
          matches,
          readOnly: true,
        } as ChatgptConnectorSearchResult;
      }
      const operation = CONNECTOR_APPROVAL_OPERATIONS.action;
      const tokenTarget = targetForAction(connectorId, action, target);
      const challenge = bindApprovalChallenge(
        challengeFor(operation, tokenTarget, before.revisionHash, {
          action,
          target,
          query: input.query,
          payload: input.payload,
        }),
        input.approvalChallenge,
      );
      const rawPreview = this.driver.previewConnectorAction
        ? await this.driver.previewConnectorAction({
            connectorId,
            appId: before.appId,
            action,
            target,
            query: input.query,
            payload: input.payload,
            expectedRevisionHash: before.revisionHash,
          })
        : {};
      const dialog = dialogEvidence(rawPreview);
      if (dialog)
        return {
          state: "requires_action",
          connectorId,
          revisionHash: before.revisionHash,
          reason: `${dialog.kind}-required`,
          code: dialog.code,
          dryRun: false,
          approvalChallenge: challenge,
          evidence: dialog,
        };
      const preview = safePreview(before, operation, target, challenge, rawPreview);
      if (input.dryRun)
        return {
          state: "requires_action",
          connectorId,
          revisionHash: before.revisionHash,
          reason: "approval-required",
          code: "approval_required",
          dryRun: true,
          approvalChallenge: challenge,
          preview,
        };
      if (!this.approvalAuthority)
        return {
          state: "requires_action",
          connectorId,
          revisionHash: before.revisionHash,
          reason: "approval-authority-unavailable",
          code: "approval_required",
          dryRun: false,
          approvalChallenge: challenge,
          preview,
        };
      const consumed = this.approvalAuthority.consumeGrant(input.approvalGrant, challenge, {
        principal: this.principal,
        session: this.session,
      });
      if (consumed.state !== "consumed")
        return {
          state: "requires_action",
          connectorId,
          revisionHash: before.revisionHash,
          reason: consumed.reason,
          code:
            consumed.reason === "approval-grant-mismatch"
              ? "approval_grant_mismatch"
              : "approval_required",
          dryRun: false,
          approvalChallenge: challenge,
          preview,
        };
      if (!this.driver.actionConnector)
        return unsupported("unsupported-action", {
          connectorId,
          revisionHash: before.revisionHash,
          code: "unsupported_action",
        });
      const current = safeConnector(await this.driver.getConnector(connectorId));
      if (current.connectorId !== connectorId)
        return conflict(connectorId, before.revisionHash, current.revisionHash);
      if (current.revisionHash !== before.revisionHash)
        return conflict(connectorId, before.revisionHash, current.revisionHash);
      const result = await this.driver.actionConnector({
        connectorId,
        appId: before.appId,
        action,
        target,
        query: input.query,
        payload: input.payload,
        expectedRevisionHash: before.revisionHash,
      });
      const resultDialog = dialogEvidence(result);
      if (resultDialog)
        return {
          state: "requires_action",
          connectorId,
          revisionHash: before.revisionHash,
          reason: `${resultDialog.kind}-required`,
          code: resultDialog.code,
          dryRun: false,
          approvalChallenge: challenge,
          evidence: resultDialog,
          preview,
        };
      const after = safeConnector(await this.driver.getConnector(connectorId));
      if (after.connectorId !== connectorId)
        return conflict(connectorId, before.revisionHash, after.revisionHash);
      if (after.revisionHash !== before.revisionHash)
        return conflict(connectorId, before.revisionHash, after.revisionHash);
      const resultRecord =
        result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      return {
        state: "ok",
        connectorId,
        revisionHash: after.revisionHash,
        operation,
        target,
        action: true,
        summary: safeSummary(resultRecord.summary) ?? "Connector action completed.",
        ...(nonEmpty(resultRecord.operationId)
          ? { operationId: resultRecord.operationId.trim().slice(0, 200) }
          : {}),
      };
    } catch (error) {
      return classifyFailure(error, { connectorId: connectorId || undefined });
    }
  }
}

export function connectorActionApprovalTarget(
  connectorId: string,
  action: string,
  target: string,
): string {
  return targetForAction(
    id(connectorId, "connectorId"),
    id(action, "action"),
    id(target, "target"),
  );
}

export function listChatgptApps(
  driver: ChatgptAppsDriver,
  options?: ChatgptAppsServiceOptions,
): Promise<ChatgptAppsListResult | ChatgptAppsResultBase> {
  return new ChatgptAppsService(driver, options).listApps();
}
export function getChatgptApp(
  driver: ChatgptAppsDriver,
  appId: string,
  options?: ChatgptAppsServiceOptions,
): Promise<ChatgptAppGetResult | ChatgptAppsResultBase> {
  return new ChatgptAppsService(driver, options).getApp(appId);
}
export function listChatgptConnectors(
  driver: ChatgptAppsDriver,
  options?: ChatgptAppsServiceOptions,
): Promise<ChatgptConnectorsListResult | ChatgptAppsResultBase> {
  return new ChatgptAppsService(driver, options).listConnectors();
}
export function getChatgptConnector(
  driver: ChatgptAppsDriver,
  connectorId: string,
  options?: ChatgptAppsServiceOptions,
): Promise<ChatgptConnectorGetResult | ChatgptAppsResultBase> {
  return new ChatgptAppsService(driver, options).getConnector(connectorId);
}
export function authorizeChatgptConnector(
  driver: ChatgptAppsDriver,
  input: ChatgptConnectorAuthorizeInput,
  options?: ChatgptAppsServiceOptions,
): Promise<ChatgptAppsOperationResult> {
  return new ChatgptAppsService(driver, options).authorizeConnector(input);
}
export function actionChatgptConnector(
  driver: ChatgptAppsDriver,
  input: ChatgptConnectorActionInput,
  options?: ChatgptAppsServiceOptions,
): Promise<ChatgptAppsOperationResult> {
  return new ChatgptAppsService(driver, options).actionConnector(input);
}

export const __test__ = {
  safeApp,
  safeConnector,
  safeAppCapability,
  safeConnectorCapability,
  safeSourceMatches,
  dialogEvidence,
  connectorActionApprovalTarget,
};
