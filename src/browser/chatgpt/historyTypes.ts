import type { ApprovalChallenge, ApprovalGrantAuthority } from "../approvalToken.js";
import type { BrowserResponseProvenance } from "../types.js";
import type { ChatgptConversationRevision } from "./revision.js";
import type { ChatgptConversationSnapshot, ChatgptConversationTurnSnapshot } from "./types.js";

export type ChatgptHistoryOperation =
  | "chatgpt.history.edit"
  | "chatgpt.history.regenerate"
  | "chatgpt.history.branch";

export interface ChatgptCapabilityEvidence {
  source: "chatgpt-dom";
  capturedAt: string;
  pageIdentity: "chatgpt_app" | "auth" | "challenge" | "other" | "unknown";
  loginState: "logged_in" | "login_required" | "challenge_required" | "unknown";
  controls: Record<string, "available" | "unavailable" | "unknown">;
  reason?: string;
}

export interface ChatgptHistoryIdentity {
  conversationId: string;
  turnId?: string;
  messageId?: string;
  blockId?: string;
}

export interface ChatgptHistorySnapshot {
  conversationId: string;
  revisionHash: string;
  revision: ChatgptConversationRevision;
  snapshot: ChatgptConversationSnapshot;
  turns: ChatgptConversationTurnSnapshot[];
  capability?: ChatgptCapabilityEvidence;
  provenance: BrowserResponseProvenance[];
}

export interface ChatgptHistoryConflict {
  state: "conflict";
  operation?: ChatgptHistoryOperation;
  conversationId: string;
  revisionHash?: string;
  expectedRevisionHash?: string;
  observedRevisionHash?: string;
  reason: "revision-conflict" | "identity-conflict" | "parent-conflict";
  capability?: ChatgptCapabilityEvidence;
  provenance: BrowserResponseProvenance[];
}

export interface ChatgptHistoryRequiresAction {
  state: "requires_action";
  operation?: ChatgptHistoryOperation;
  conversationId?: string;
  revisionHash?: string;
  approvalChallenge?: ApprovalChallenge;
  reason: string;
  capability?: ChatgptCapabilityEvidence;
  provenance: BrowserResponseProvenance[];
}

export interface ChatgptHistoryUnsupported {
  state: "unsupported";
  operation?: ChatgptHistoryOperation;
  conversationId?: string;
  reason: string;
  capability?: ChatgptCapabilityEvidence;
  provenance: BrowserResponseProvenance[];
}
export type ChatgptHistoryFailure = ChatgptHistoryRequiresAction | ChatgptHistoryUnsupported;

export interface ChatgptHistoryMutationInput extends ChatgptHistoryIdentity {
  expectedRevisionHash: string;
  dryRun?: boolean;
  approvalChallenge?: ApprovalChallenge;
  approvalGrant?: string;
  signal?: AbortSignal;
}

export interface ChatgptHistoryServiceOptions {
  approvalAuthority?: ApprovalGrantAuthority;
  principal?: string;
  session?: string;
}

export interface ChatgptHistoryEditInput extends ChatgptHistoryMutationInput {
  text: string;
}

export interface ChatgptHistoryRegenerateInput extends ChatgptHistoryMutationInput {
  instruction?: string;
}

export interface ChatgptHistoryBranchInput extends ChatgptHistoryMutationInput {
  parentTurnId: string;
  parentMessageId?: string;
}

export interface ChatgptHistoryMutationResult {
  state: "ok";
  operation: ChatgptHistoryOperation;
  conversationId: string;
  revisionHash: string;
  revision: ChatgptConversationRevision;
  snapshot: ChatgptConversationSnapshot;
  turns: ChatgptConversationTurnSnapshot[];
  provenance: BrowserResponseProvenance[];
  capability?: ChatgptCapabilityEvidence;
  changed: true;
}

export interface ChatgptHistoryBranchResult extends ChatgptHistoryMutationResult {
  operation: "chatgpt.history.branch";
  parentTurnId: string;
  parentMessageId?: string;
  branchConversationId: string;
}

export type ChatgptHistorySnapshotResult = ChatgptHistorySnapshot | ChatgptHistoryFailure;
export type ChatgptHistoryMutationResponse =
  | ChatgptHistoryMutationResult
  | ChatgptHistoryBranchResult
  | ChatgptHistoryConflict
  | ChatgptHistoryRequiresAction
  | ChatgptHistoryUnsupported;

export interface ChatgptHistoryDriver {
  snapshot(input: {
    conversationId: string;
    signal?: AbortSignal;
  }): Promise<ChatgptHistoryDriverSnapshot>;
  edit(input: {
    conversationId: string;
    turnId: string;
    messageId?: string;
    blockId?: string;
    text: string;
    revisionHash: string;
    signal?: AbortSignal;
  }): Promise<void>;
  regenerate(input: {
    conversationId: string;
    turnId: string;
    messageId?: string;
    instruction?: string;
    revisionHash: string;
    signal?: AbortSignal;
  }): Promise<void>;
  branch(input: {
    conversationId: string;
    parentTurnId: string;
    parentMessageId?: string;
    revisionHash: string;
    signal?: AbortSignal;
  }): Promise<{ conversationId: string }>;
}

export interface ChatgptHistoryDriverSnapshot {
  snapshot: ChatgptConversationSnapshot;
  revision: ChatgptConversationRevision;
  capability?: ChatgptCapabilityEvidence;
  provenance?: BrowserResponseProvenance[];
}
