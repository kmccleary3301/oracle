import {
  bindApprovalChallenge,
  createApprovalChallenge,
  type ApprovalChallenge,
} from "../approvalToken.js";
import type { BrowserResponseProvenance } from "../types.js";
import { computeChatgptConversationRevision } from "./revision.js";
import type { ChatgptHistoryServiceOptions } from "./historyTypes.js";
import type {
  ChatgptHistoryBranchInput,
  ChatgptHistoryBranchResult,
  ChatgptHistoryConflict,
  ChatgptHistoryDriver,
  ChatgptHistoryDriverSnapshot,
  ChatgptHistoryEditInput,
  ChatgptHistoryFailure,
  ChatgptHistoryMutationInput,
  ChatgptHistoryMutationResponse,
  ChatgptHistoryMutationResult,
  ChatgptHistoryOperation,
  ChatgptHistoryRegenerateInput,
  ChatgptHistoryRequiresAction,
  ChatgptHistorySnapshotResult,
  ChatgptCapabilityEvidence,
} from "./historyTypes.js";
import type { ChatgptConversationSnapshot, ChatgptConversationTurnSnapshot } from "./types.js";

export type * from "./historyTypes.js";

export const CHATGPT_HISTORY_APPROVAL_OPERATIONS = {
  edit: "chatgpt.history.edit",
  regenerate: "chatgpt.history.regenerate",
  branch: "chatgpt.history.branch",
} as const;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function exact(value: unknown, label: string): string {
  if (!nonEmpty(value)) throw new Error(`${label} is required.`);
  return value.trim();
}

function safeTurns(snapshot: ChatgptConversationSnapshot): ChatgptConversationTurnSnapshot[] {
  return [...snapshot.turns]
    .filter((turn) => turn && Number.isFinite(turn.index))
    .sort((a, b) => a.index - b.index);
}

function safeCapability(value: unknown): ChatgptCapabilityEvidence | undefined {
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
  const controls: Record<string, "available" | "unavailable" | "unknown"> = {};
  if (input.controls && typeof input.controls === "object") {
    for (const [key, raw] of Object.entries(input.controls)) {
      if (!/^[a-z][a-z0-9_-]{0,40}$/i.test(key)) continue;
      controls[key] = ["available", "unavailable", "unknown"].includes(String(raw))
        ? (String(raw) as "available" | "unavailable" | "unknown")
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

function provenance(
  conversationId: string,
  snapshot: ChatgptConversationSnapshot,
  _revisionHash: string,
  existing?: BrowserResponseProvenance[],
): BrowserResponseProvenance[] {
  if (existing?.length) return existing.slice(0, 16).map((entry) => ({ ...entry }));
  const latest = snapshot.latestAssistantTurn ?? snapshot.latestUserTurn;
  return [
    {
      source: "chatgpt-dom",
      capturedAt: new Date().toISOString(),
      conversationUrl: snapshot.page.href,
      conversationId,
      turnId: latest?.turnId ?? null,
      messageId: latest?.messageId ?? null,
      turnIndex: latest?.index,
    },
  ];
}

function operationChallenge(
  operation: ChatgptHistoryOperation,
  target: string,
  revision: string,
  payload: unknown,
): ApprovalChallenge {
  return createApprovalChallenge({ operation, target, revision, payload });
}

function targetFor(input: ChatgptHistoryMutationInput): string {
  return [
    input.conversationId,
    input.turnId ?? "",
    input.messageId ?? "",
    input.blockId ?? "",
  ].join(":");
}

function approvalPayload(
  operation: ChatgptHistoryOperation,
  input: ChatgptHistoryMutationInput,
): Record<string, string | null> {
  if (operation === CHATGPT_HISTORY_APPROVAL_OPERATIONS.edit) {
    return { text: exact((input as ChatgptHistoryEditInput).text, "text") };
  }
  if (operation === CHATGPT_HISTORY_APPROVAL_OPERATIONS.regenerate) {
    return {
      instruction: (input as ChatgptHistoryRegenerateInput).instruction?.trim() || null,
    };
  }
  const branch = input as ChatgptHistoryBranchInput;
  return {
    parentTurnId: exact(branch.parentTurnId, "parentTurnId"),
    parentMessageId: branch.parentMessageId?.trim() || null,
  };
}

function capabilityOf(
  snapshot: ChatgptHistoryDriverSnapshot,
): ChatgptCapabilityEvidence | undefined {
  return safeCapability(snapshot.capability);
}

function conflict(
  input: ChatgptHistoryMutationInput,
  observed: ChatgptHistoryDriverSnapshot,
  reason: ChatgptHistoryConflict["reason"] = "revision-conflict",
): ChatgptHistoryConflict {
  const observedRevisionHash = observed.revision.hash;
  return {
    state: "conflict",
    operation: undefined,
    conversationId: input.conversationId,
    expectedRevisionHash: input.expectedRevisionHash,
    observedRevisionHash,
    revisionHash: observedRevisionHash,
    reason,
    capability: capabilityOf(observed),
    provenance: provenance(
      input.conversationId,
      observed.snapshot,
      observedRevisionHash,
      observed.provenance,
    ),
  };
}

function requiresAction(
  input: ChatgptHistoryMutationInput,
  observed: ChatgptHistoryDriverSnapshot,
  operation: ChatgptHistoryOperation,
  reason: string,
  approvalChallenge: ApprovalChallenge,
): ChatgptHistoryRequiresAction {
  return {
    state: "requires_action",
    operation,
    conversationId: input.conversationId,
    revisionHash: observed.revision.hash,
    approvalChallenge,
    reason,
    capability: capabilityOf(observed),
    provenance: provenance(
      input.conversationId,
      observed.snapshot,
      observed.revision.hash,
      observed.provenance,
    ),
  };
}

function failure(
  error: unknown,
  operation?: ChatgptHistoryOperation,
  conversationId?: string,
): ChatgptHistoryFailure {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const unsupported = /unsupported|unavailable|not implemented|missing control/.test(message);
  return {
    state: unsupported ? "unsupported" : "requires_action",
    ...(operation ? { operation } : {}),
    ...(conversationId ? { conversationId } : {}),
    reason: unsupported ? "unsupported" : "history-operation-failed",
    provenance: [],
  };
}

function findLastTurnByRole(
  turns: ChatgptConversationSnapshot["turns"],
  role: "assistant" | "user",
): ChatgptConversationSnapshot["turns"][number] | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.role === role) return turn;
  }
  return undefined;
}

function checkedSnapshot(
  inputConversationId: string,
  value: ChatgptHistoryDriverSnapshot,
): ChatgptHistoryDriverSnapshot {
  const snapshot = value.snapshot;
  const pageConversationId = snapshot.page.conversationId;
  const revision =
    value.revision ?? computeChatgptConversationRevision(snapshot, snapshot.page.href);
  const observedConversationId = revision.conversationId ?? pageConversationId;
  if (observedConversationId && observedConversationId !== inputConversationId) {
    throw new Error("conversation identity conflict");
  }
  const turns = safeTurns(snapshot);
  return {
    ...value,
    revision,
    snapshot: {
      ...snapshot,
      turns,
      latestAssistantTurn: findLastTurnByRole(turns, "assistant"),
      latestUserTurn: findLastTurnByRole(turns, "user"),
    },
  };
}

export class ChatgptHistoryService {
  constructor(
    private readonly driver: ChatgptHistoryDriver,
    private readonly options: ChatgptHistoryServiceOptions = {},
  ) {}

  async snapshot(
    conversationIdInput: string,
    signal?: AbortSignal,
  ): Promise<ChatgptHistorySnapshotResult> {
    let conversationId = "";
    try {
      conversationId = exact(conversationIdInput, "conversationId");
      const observed = checkedSnapshot(
        conversationId,
        await this.driver.snapshot({ conversationId, signal }),
      );
      return {
        conversationId,
        revisionHash: observed.revision.hash,
        revision: observed.revision,
        snapshot: observed.snapshot,
        turns: safeTurns(observed.snapshot),
        capability: capabilityOf(observed),
        provenance: provenance(
          conversationId,
          observed.snapshot,
          observed.revision.hash,
          observed.provenance,
        ),
      };
    } catch (error) {
      return failure(error, undefined, conversationId || undefined);
    }
  }

  async history(
    conversationIdInput: string,
    signal?: AbortSignal,
  ): Promise<ChatgptHistorySnapshotResult> {
    return this.snapshot(conversationIdInput, signal);
  }

  async edit(input: ChatgptHistoryEditInput): Promise<ChatgptHistoryMutationResponse> {
    return this.mutate(
      input,
      CHATGPT_HISTORY_APPROVAL_OPERATIONS.edit,
      async (before, operationInput) => {
        const text = exact(operationInput.text, "text");
        if (text.length > 100_000) throw new Error("text is too long");
        const turnId = exact(operationInput.turnId, "turnId");
        const turn = requiredTurn(before.snapshot, turnId, operationInput.messageId);
        if (turn.role !== "user") throw new Error("edit target is not a user turn");
        await this.driver.edit({
          conversationId: operationInput.conversationId,
          turnId,
          messageId: operationInput.messageId,
          blockId: operationInput.blockId,
          text,
          revisionHash: before.revision.hash,
          signal: operationInput.signal,
        });
        return { text, target: turn };
      },
      (after, details) => {
        const turn = requiredTurn(after.snapshot, exact(input.turnId, "turnId"), input.messageId);
        return turn.text === String(details.text);
      },
    );
  }

  async regenerate(input: ChatgptHistoryRegenerateInput): Promise<ChatgptHistoryMutationResponse> {
    return this.mutate(
      input,
      CHATGPT_HISTORY_APPROVAL_OPERATIONS.regenerate,
      async (before, operationInput) => {
        const turnId = exact(operationInput.turnId, "turnId");
        const turn = requiredTurn(before.snapshot, turnId, operationInput.messageId);
        if (turn.role !== "assistant")
          throw new Error("regenerate target is not an assistant turn");
        await this.driver.regenerate({
          conversationId: operationInput.conversationId,
          turnId,
          messageId: operationInput.messageId,
          instruction: operationInput.instruction?.trim() || undefined,
          revisionHash: before.revision.hash,
          signal: operationInput.signal,
        });
        return { target: turn };
      },
      (after) =>
        Boolean(requiredTurn(after.snapshot, exact(input.turnId, "turnId"), input.messageId)),
    );
  }

  async branch(input: ChatgptHistoryBranchInput): Promise<ChatgptHistoryMutationResponse> {
    const parentTurnId = exact(input.parentTurnId, "parentTurnId");
    if (input.turnId && input.turnId !== parentTurnId) {
      return failure(
        new Error("parent identity conflict"),
        CHATGPT_HISTORY_APPROVAL_OPERATIONS.branch,
        input.conversationId,
      );
    }
    const branchInput = { ...input, turnId: parentTurnId };
    return this.mutate(
      branchInput,
      CHATGPT_HISTORY_APPROVAL_OPERATIONS.branch,
      async (before, operationInput) => {
        const parent = requiredTurn(before.snapshot, parentTurnId, operationInput.parentMessageId);
        const result = await this.driver.branch({
          conversationId: operationInput.conversationId,
          parentTurnId,
          parentMessageId: operationInput.parentMessageId,
          revisionHash: before.revision.hash,
          signal: operationInput.signal,
        });
        const branchConversationId = exact(result?.conversationId, "branch conversationId");
        if (branchConversationId === operationInput.conversationId)
          throw new Error("branch identity conflict");
        return { branchConversationId, parent };
      },
      (after, details) =>
        after.revision.conversationId === details.branchConversationId ||
        after.snapshot.page.conversationId === details.branchConversationId,
      true,
    );
  }

  private async mutate<T extends ChatgptHistoryMutationInput, D extends Record<string, unknown>>(
    input: T,
    operation: ChatgptHistoryOperation,
    action: (before: ChatgptHistoryDriverSnapshot, input: T) => Promise<D>,
    verify: (after: ChatgptHistoryDriverSnapshot, details: D) => boolean,
    branch = false,
  ): Promise<ChatgptHistoryMutationResponse> {
    let conversationId = "";
    try {
      conversationId = exact(input.conversationId, "conversationId");
      const expectedRevisionHash = exact(input.expectedRevisionHash, "expectedRevisionHash");
      const before = checkedSnapshot(
        conversationId,
        await this.driver.snapshot({ conversationId, signal: input.signal }),
      );
      if (before.revision.hash !== expectedRevisionHash) return conflict(input, before);
      const approvalChallenge = bindApprovalChallenge(
        operationChallenge(
          operation,
          targetFor({ ...input, conversationId }),
          before.revision.hash,
          approvalPayload(operation, input),
        ),
        input.approvalChallenge,
      );
      if (input.dryRun)
        return requiresAction(input, before, operation, "approval-required", approvalChallenge);
      if (!this.options.approvalAuthority)
        return requiresAction(
          input,
          before,
          operation,
          "approval-authority-unavailable",
          approvalChallenge,
        );
      const consumed = this.options.approvalAuthority.consumeGrant(
        input.approvalGrant,
        approvalChallenge,
        { principal: this.options.principal, session: this.options.session },
      );
      if (consumed.state !== "consumed")
        return requiresAction(input, before, operation, consumed.reason, approvalChallenge);
      if (input.signal?.aborted)
        return requiresAction(input, before, operation, "cancellation-race", approvalChallenge);
      const details = await action(before, input);
      if (input.signal?.aborted) {
        const observed = checkedSnapshot(
          conversationId,
          await this.driver.snapshot({ conversationId, signal: input.signal }),
        );
        return requiresAction(
          { ...input, conversationId },
          observed,
          operation,
          "cancellation-race",
          approvalChallenge,
        );
      }
      const afterId =
        branch && "branchConversationId" in details
          ? String(details.branchConversationId)
          : conversationId;
      const after = checkedSnapshot(
        afterId,
        await this.driver.snapshot({ conversationId: afterId, signal: input.signal }),
      );
      if (after.revision.hash === before.revision.hash || !verify(after, details)) {
        return requiresAction(
          { ...input, conversationId: afterId },
          after,
          operation,
          "mutation-not-verified",
          approvalChallenge,
        );
      }
      const base = {
        state: "ok" as const,
        operation,
        conversationId: afterId,
        revisionHash: after.revision.hash,
        revision: after.revision,
        snapshot: after.snapshot,
        turns: safeTurns(after.snapshot),
        capability: capabilityOf(after),
        provenance: provenance(afterId, after.snapshot, after.revision.hash, after.provenance),
        changed: true as const,
      };
      if (branch && "branchConversationId" in details) {
        return {
          ...base,
          operation: CHATGPT_HISTORY_APPROVAL_OPERATIONS.branch,
          parentTurnId: exact(input.turnId, "turnId"),
          ...("parentMessageId" in input &&
          typeof input.parentMessageId === "string" &&
          input.parentMessageId
            ? { parentMessageId: input.parentMessageId }
            : input.messageId
              ? { parentMessageId: input.messageId }
              : {}),
          branchConversationId: String(details.branchConversationId),
        } satisfies ChatgptHistoryBranchResult;
      }
      return base satisfies ChatgptHistoryMutationResult;
    } catch (error) {
      return failure(error, operation, conversationId || undefined);
    }
  }
}

function requiredTurn(
  snapshot: ChatgptConversationSnapshot,
  turnId: string,
  messageId?: string,
): ChatgptConversationTurnSnapshot {
  const normalizedTurnId = exact(turnId, "turnId");
  const found = snapshot.turns.find((turn) => turn.turnId === normalizedTurnId);
  if (!found) throw new Error("turn identity conflict");
  if (messageId && found.messageId !== messageId) throw new Error("message identity conflict");
  return found;
}

export async function snapshotChatgptHistory(
  driver: ChatgptHistoryDriver,
  conversationId: string,
  signal?: AbortSignal,
): Promise<ChatgptHistorySnapshotResult> {
  return new ChatgptHistoryService(driver).snapshot(conversationId, signal);
}

export async function historyChatgptConversation(
  driver: ChatgptHistoryDriver,
  conversationId: string,
  signal?: AbortSignal,
): Promise<ChatgptHistorySnapshotResult> {
  return new ChatgptHistoryService(driver).history(conversationId, signal);
}

export async function editChatgptHistory(
  driver: ChatgptHistoryDriver,
  input: ChatgptHistoryEditInput,
  options?: ChatgptHistoryServiceOptions,
): Promise<ChatgptHistoryMutationResponse> {
  return new ChatgptHistoryService(driver, options).edit(input);
}

export async function regenerateChatgptHistory(
  driver: ChatgptHistoryDriver,
  input: ChatgptHistoryRegenerateInput,
  options?: ChatgptHistoryServiceOptions,
): Promise<ChatgptHistoryMutationResponse> {
  return new ChatgptHistoryService(driver, options).regenerate(input);
}

export async function branchChatgptHistory(
  driver: ChatgptHistoryDriver,
  input: ChatgptHistoryBranchInput,
  options?: ChatgptHistoryServiceOptions,
): Promise<ChatgptHistoryMutationResponse> {
  return new ChatgptHistoryService(driver, options).branch(input);
}

export const chatgptHistoryApprovalChallengeForTest = operationChallenge;
export const sanitizeChatgptHistoryCapabilityForTest = safeCapability;
