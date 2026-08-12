import type { BrowserResponseProvenance } from "../types.js";
import type { ChatgptCapabilityEvidence } from "./historyTypes.js";
import type {
  ChatgptTemporaryCloseResult,
  ChatgptTemporaryDriver,
  ChatgptTemporaryOperationResult,
  ChatgptTemporarySnapshot,
  ChatgptTemporaryStartResult,
  ChatgptTemporaryStatusResult,
} from "./temporaryTypes.js";

export type * from "./temporaryTypes.js";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function exact(value: unknown, label: string): string {
  if (!nonEmpty(value)) throw new Error(`${label} is required.`);
  return value.trim();
}

function capability(value: unknown): ChatgptCapabilityEvidence | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<ChatgptCapabilityEvidence>;
  const pageIdentity = ["chatgpt_app", "auth", "challenge", "other", "unknown"].includes(
    String(input.pageIdentity),
  )
    ? (input.pageIdentity as ChatgptCapabilityEvidence["pageIdentity"])
    : "unknown";
  const loginState = ["logged_in", "login_required", "challenge_required", "unknown"].includes(
    String(input.loginState),
  )
    ? (input.loginState as ChatgptCapabilityEvidence["loginState"])
    : "unknown";
  const controls: ChatgptCapabilityEvidence["controls"] = {};
  if (input.controls && typeof input.controls === "object") {
    for (const [key, value] of Object.entries(input.controls)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(key)) continue;
      controls[key] = ["available", "unavailable", "unknown"].includes(String(value))
        ? (String(value) as "available" | "unavailable" | "unknown")
        : "unknown";
    }
  }
  return {
    source: "chatgpt-dom",
    capturedAt: nonEmpty(input.capturedAt) ? input.capturedAt : new Date().toISOString(),
    pageIdentity,
    loginState,
    controls,
    ...(nonEmpty(input.reason) ? { reason: input.reason.slice(0, 240) } : {}),
  };
}

function provenance(snapshot: ChatgptTemporarySnapshot): BrowserResponseProvenance[] {
  return (snapshot.provenance ?? []).slice(0, 16).map((entry) => ({ ...entry }));
}

function safeSnapshot(value: ChatgptTemporarySnapshot): ChatgptTemporarySnapshot {
  return {
    state: ["temporary", "closed", "regular", "unknown"].includes(value.state)
      ? value.state
      : "unknown",
    conversationId: nonEmpty(value.conversationId) ? value.conversationId : null,
    conversationUrl: nonEmpty(value.conversationUrl) ? value.conversationUrl : null,
    persisted: typeof value.persisted === "boolean" ? value.persisted : null,
    closed: Boolean(value.closed),
    revisionHash: nonEmpty(value.revisionHash) ? value.revisionHash : null,
    capability: capability(value.capability),
    provenance: provenance(value),
  };
}

function baseFailure(
  error: unknown,
  operation: string,
  conversationId?: string | null,
): ChatgptTemporaryOperationResult {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return {
    state: /unsupported|unavailable|not implemented|missing control/.test(message)
      ? "unsupported"
      : "requires_action",
    ...(conversationId !== undefined ? { conversationId } : {}),
    reason: /unsupported|unavailable|not implemented|missing control/.test(message)
      ? "unsupported"
      : `${operation}-verification-required`,
    provenance: [],
  };
}

export class ChatgptTemporaryChatService {
  constructor(private readonly driver: ChatgptTemporaryDriver) {}

  async start(
    input: { conversationId?: string; signal?: AbortSignal } = {},
  ): Promise<ChatgptTemporaryOperationResult> {
    try {
      if (input.signal?.aborted)
        return { state: "requires_action", reason: "cancellation-race", provenance: [] };
      const snapshot = safeSnapshot(await this.driver.start(input));
      if (snapshot.state !== "temporary" || snapshot.persisted !== false || snapshot.closed) {
        return {
          state: "requires_action",
          conversationId: snapshot.conversationId,
          conversationUrl: snapshot.conversationUrl,
          reason: "temporary-non-persistence-not-verified",
          snapshot,
          capability: snapshot.capability,
          provenance: provenance(snapshot),
        };
      }
      return {
        state: "ok",
        temporary: true,
        persisted: false,
        started: true,
        conversationId: snapshot.conversationId,
        conversationUrl: snapshot.conversationUrl,
        snapshot,
        capability: snapshot.capability,
        provenance: provenance(snapshot),
      } satisfies ChatgptTemporaryStartResult;
    } catch (error) {
      return baseFailure(error, "temporary-start", input.conversationId);
    }
  }

  async status(
    input: { conversationId?: string; signal?: AbortSignal } = {},
  ): Promise<ChatgptTemporaryOperationResult> {
    try {
      const snapshot = safeSnapshot(await this.driver.status(input));
      return {
        state: "ok",
        conversationId: snapshot.conversationId,
        conversationUrl: snapshot.conversationUrl,
        snapshot,
        capability: snapshot.capability,
        provenance: provenance(snapshot),
      } satisfies ChatgptTemporaryStatusResult;
    } catch (error) {
      return baseFailure(error, "temporary-status", input.conversationId);
    }
  }

  async close(input: {
    conversationId: string;
    signal?: AbortSignal;
  }): Promise<ChatgptTemporaryOperationResult> {
    let conversationId = "";
    try {
      conversationId = exact(input.conversationId, "conversationId");
      if (input.signal?.aborted)
        return {
          state: "requires_action",
          conversationId,
          reason: "cancellation-race",
          provenance: [],
        };
      const snapshot = safeSnapshot(await this.driver.close({ ...input, conversationId }));
      if (!snapshot.closed || snapshot.persisted !== false || snapshot.state === "regular") {
        return {
          state: "requires_action",
          conversationId,
          conversationUrl: snapshot.conversationUrl,
          reason: "temporary-close-not-verified",
          snapshot,
          capability: snapshot.capability,
          provenance: provenance(snapshot),
        };
      }
      return {
        state: "ok",
        temporary: true,
        persisted: false,
        closed: true,
        conversationId,
        conversationUrl: snapshot.conversationUrl,
        snapshot,
        capability: snapshot.capability,
        provenance: provenance(snapshot),
      } satisfies ChatgptTemporaryCloseResult;
    } catch (error) {
      return baseFailure(error, "temporary-close", conversationId || undefined);
    }
  }
}

export async function startChatgptTemporaryChat(
  driver: ChatgptTemporaryDriver,
  input: { conversationId?: string; signal?: AbortSignal } = {},
): Promise<ChatgptTemporaryOperationResult> {
  return new ChatgptTemporaryChatService(driver).start(input);
}

export async function getChatgptTemporaryChatStatus(
  driver: ChatgptTemporaryDriver,
  input: { conversationId?: string; signal?: AbortSignal } = {},
): Promise<ChatgptTemporaryOperationResult> {
  return new ChatgptTemporaryChatService(driver).status(input);
}

export async function closeChatgptTemporaryChat(
  driver: ChatgptTemporaryDriver,
  input: { conversationId: string; signal?: AbortSignal },
): Promise<ChatgptTemporaryOperationResult> {
  return new ChatgptTemporaryChatService(driver).close(input);
}
