import type { ApprovalChallenge } from "../approvalToken.js";

export type ChatgptAppsOperationState =
  | "ok"
  | "unsupported"
  | "requires_action"
  | "conflict"
  | "disconnected";

export type ChatgptAppCapability =
  | "search"
  | "read"
  | "sync"
  | "write"
  | "action"
  | "share"
  | "authorize";

export type ChatgptConnectorCapability = ChatgptAppCapability | "source_search" | "external_action";

export interface ChatgptAppCapabilityEvidence {
  observed: true;
  pageIdentity?: "chatgpt_app" | "auth" | "challenge" | "other" | "unknown";
  loginState?: "logged_in" | "login_required" | "challenge_required" | "unknown";
  capabilities: ChatgptAppCapability[];
  reason?: string;
}

export interface ChatgptConnectorCapabilityEvidence {
  observed: true;
  sourceSearch: "available" | "unavailable" | "unknown";
  externalActions: "available" | "unavailable" | "unknown";
  authorization: "available" | "unavailable" | "unknown";
  capabilities: ChatgptConnectorCapability[];
  reason?: string;
}

export interface ChatgptAppRecord {
  appId: string;
  name: string;
  revisionHash: string;
  connected?: boolean;
  capability?: ChatgptAppCapabilityEvidence;
}

export interface ChatgptConnectorRecord {
  connectorId: string;
  appId: string;
  name: string;
  revisionHash: string;
  connectionState: "connected" | "disconnected" | "available" | "unknown";
  capability?: ChatgptConnectorCapabilityEvidence;
}

export interface ChatgptConnectorSourceMatch {
  sourceId: string;
  title: string;
  url?: string;
  snippet?: string;
}

export interface ChatgptConnectorActionPreview {
  connectorId: string;
  appId: string;
  operation: string;
  target: string;
  revisionHash: string;
  approvalChallenge: ApprovalChallenge;
  external: boolean;
  readOnly: boolean;
  summary: string;
}

export type ChatgptConnectorDialogKind = "oauth" | "account" | "payment" | "unknown";

export interface ChatgptConnectorDialogEvidence {
  kind: ChatgptConnectorDialogKind;
  observed: true;
  code: "oauth_required" | "account_required" | "payment_required" | "unknown_dialog";
}

export type ChatgptAppsFailureCode =
  | "allowlist_rejected"
  | "invalid_observation"
  | "approval_required"
  | "approval_grant_mismatch"
  | "revision_conflict"
  | "oauth_required"
  | "account_required"
  | "payment_required"
  | "unknown_dialog"
  | "unsupported_account_ui"
  | "unsupported_action"
  | "disconnected";

export interface ChatgptAppsResultBase {
  state: ChatgptAppsOperationState;
  appId?: string;
  connectorId?: string;
  revisionHash?: string;
  approvalChallenge?: ApprovalChallenge;
  reason?: string;
  code?: ChatgptAppsFailureCode;
  evidence?: ChatgptConnectorDialogEvidence;
}

export interface ChatgptAppsListResult extends ChatgptAppsResultBase {
  state: "ok";
  apps: ChatgptAppRecord[];
}

export interface ChatgptAppGetResult extends ChatgptAppsResultBase {
  state: "ok";
  app: ChatgptAppRecord;
}

export interface ChatgptConnectorsListResult extends ChatgptAppsResultBase {
  state: "ok";
  connectors: ChatgptConnectorRecord[];
}

export interface ChatgptConnectorGetResult extends ChatgptAppsResultBase {
  state: "ok";
  connector: ChatgptConnectorRecord;
}

export interface ChatgptConnectorSearchResult extends ChatgptAppsResultBase {
  state: "ok";
  connectorId: string;
  revisionHash: string;
  query: string;
  matches: ChatgptConnectorSourceMatch[];
  readOnly: true;
}

export interface ChatgptConnectorActionResult extends ChatgptAppsResultBase {
  state: "ok";
  connectorId: string;
  revisionHash: string;
  operation: string;
  target: string;
  action: true;
  summary?: string;
  operationId?: string;
}

export interface ChatgptAppsRequiresActionResult extends ChatgptAppsResultBase {
  state: "requires_action";
  reason: string;
  dryRun: boolean;
  preview?: ChatgptConnectorActionPreview;
  evidence?: ChatgptConnectorDialogEvidence;
}
export interface ChatgptAppsConflictResult extends ChatgptAppsResultBase {
  state: "conflict";
  reason: "revision-conflict" | "identity-conflict";
  expectedRevisionHash?: string;
  observedRevisionHash?: string;
}

export interface ChatgptAppsUnsupportedResult extends ChatgptAppsResultBase {
  state: "unsupported";
  reason: string;
}

export type ChatgptAppsOperationResult =
  | ChatgptAppsListResult
  | ChatgptAppGetResult
  | ChatgptConnectorsListResult
  | ChatgptConnectorGetResult
  | ChatgptConnectorSearchResult
  | ChatgptConnectorActionResult
  | ChatgptAppsRequiresActionResult
  | ChatgptAppsConflictResult
  | ChatgptAppsUnsupportedResult
  | (ChatgptAppsResultBase & { state: "disconnected"; reason: string });

/** Caller-provided filters are always intersected with the trusted policy. */
export interface ChatgptAppsAllowlist {
  appIds?: readonly string[];
  connectorIds?: readonly string[];
}

/** Server-owned authorization policy for ChatGPT apps and connectors. */
export interface AppConnectorPolicy extends ChatgptAppsAllowlist {
  /**
   * Explicit operator opt-in to permit every observed app and connector.
   * Omission (including an omitted ID list) fails closed.
   */
  allowAll?: boolean;
}

export interface ChatgptConnectorAuthorizeInput {
  connectorId: string;
  scopes?: readonly string[];
  expectedRevisionHash?: string;
  dryRun?: boolean;
  approvalChallenge?: ApprovalChallenge;
  approvalGrant?: string;
}

export type ChatgptConnectorActionKind = "search" | "read" | "write" | "action" | "share";

export interface ChatgptConnectorActionInput {
  connectorId: string;
  action: ChatgptConnectorActionKind | string;
  target?: string;
  query?: string;
  payload?: unknown;
  expectedRevisionHash?: string;
  dryRun?: boolean;
  approvalChallenge?: ApprovalChallenge;
  approvalGrant?: string;
}

export interface ChatgptAppsDriver {
  allowlist?: ChatgptAppsAllowlist;
  listApps(): Promise<unknown[]>;
  getApp(appId: string): Promise<unknown>;
  listConnectors(): Promise<unknown[]>;
  getConnector(connectorId: string): Promise<unknown>;
  authorizeConnector?(input: {
    connectorId: string;
    scopes: readonly string[];
    expectedRevisionHash: string;
  }): Promise<unknown>;
  previewConnectorAction?(input: {
    connectorId: string;
    appId: string;
    action: string;
    target: string;
    query?: string;
    payload?: unknown;
    expectedRevisionHash: string;
  }): Promise<unknown>;
  searchConnector?(input: {
    connectorId: string;
    appId: string;
    query: string;
    expectedRevisionHash: string;
  }): Promise<unknown>;
  actionConnector?(input: {
    connectorId: string;
    appId: string;
    action: string;
    target: string;
    query?: string;
    payload?: unknown;
    expectedRevisionHash: string;
  }): Promise<unknown>;
}
