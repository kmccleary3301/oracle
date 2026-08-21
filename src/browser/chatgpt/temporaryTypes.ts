import type { BrowserResponseProvenance } from "../types.js";
import type { ChatgptCapabilityEvidence } from "./historyTypes.js";

export type ChatgptTemporaryState = "temporary" | "closed" | "regular" | "unknown";

export interface ChatgptTemporarySnapshot {
  state: ChatgptTemporaryState;
  conversationId: string | null;
  conversationUrl: string | null;
  persisted: boolean | null;
  closed: boolean;
  revisionHash: string | null;
  capability?: ChatgptCapabilityEvidence;
  provenance: BrowserResponseProvenance[];
}

export interface ChatgptTemporaryResultBase {
  state: "ok" | "requires_action" | "unsupported";
  conversationId?: string | null;
  conversationUrl?: string | null;
  reason?: string;
  snapshot?: ChatgptTemporarySnapshot;
  capability?: ChatgptCapabilityEvidence;
  provenance: BrowserResponseProvenance[];
}

export interface ChatgptTemporaryStartResult extends ChatgptTemporaryResultBase {
  state: "ok";
  temporary: true;
  persisted: false;
  started: true;
  snapshot: ChatgptTemporarySnapshot;
}

export interface ChatgptTemporaryStatusResult extends ChatgptTemporaryResultBase {
  state: "ok";
  snapshot: ChatgptTemporarySnapshot;
}

export interface ChatgptTemporaryCloseResult extends ChatgptTemporaryResultBase {
  state: "ok";
  temporary: true;
  persisted: false;
  closed: true;
  snapshot: ChatgptTemporarySnapshot;
}

export interface ChatgptTemporaryDriver {
  start(input: {
    conversationId?: string;
    signal?: AbortSignal;
  }): Promise<ChatgptTemporarySnapshot>;
  status(input?: {
    conversationId?: string;
    signal?: AbortSignal;
  }): Promise<ChatgptTemporarySnapshot>;
  close(input: { conversationId: string; signal?: AbortSignal }): Promise<ChatgptTemporarySnapshot>;
}

export type ChatgptTemporaryOperationResult =
  | ChatgptTemporaryStartResult
  | ChatgptTemporaryStatusResult
  | ChatgptTemporaryCloseResult
  | ChatgptTemporaryResultBase;
