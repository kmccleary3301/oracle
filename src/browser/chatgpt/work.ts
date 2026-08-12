import type { BrowserLogger, ChromeClient } from "../types.js";
import {
  approveWorkPlan,
  classifyWorkSnapshot,
  createWorkApprovalChallenge,
  interruptWorkTurn,
  readWorkSnapshot,
  type WorkApprovalResult,
  type WorkIdentity,
  type WorkInterruptResult,
  type WorkSnapshot,
  type WorkStartResult,
  type WorkState,
  type WorkLifecycle,
} from "../actions/work.js";
import type { RequestedChatGptModeResult } from "../actions/navigation.js";
import { ensureRequestedChatGptMode } from "../actions/navigation.js";
import { submitPrompt } from "../actions/promptComposer.js";
import {
  ApprovalGrantAuthority,
  bindApprovalChallenge,
  type ApprovalChallenge,
} from "../approvalToken.js";
export type {
  WorkApprovalAction,
  WorkApprovalResult,
  WorkDeliverableSnapshot,
  WorkIdentity,
  WorkInterruptResult,
  WorkLifecycle,
  WorkPlanSnapshot,
  WorkSnapshot,
  WorkStartResult,
  WorkState,
  WorkTurnSnapshot,
  WorkUserQuestionSnapshot,
} from "../actions/work.js";
export { classifyWorkSnapshot, createWorkApprovalChallenge } from "../actions/work.js";

export interface WorkTransitionResult extends WorkIdentity {
  state: WorkState;
  lifecycle?: WorkLifecycle;
  paused?: boolean;
  verified: boolean;
  reason?: string;
}

export interface WorkBrowserDriver {
  ensureWorkMode(): Promise<RequestedChatGptModeResult>;
  readSnapshot(
    expectedConversationId?: string | null,
    expectedTaskId?: string | null,
  ): Promise<WorkSnapshot>;
  submitPrompt(prompt: string): Promise<{ accepted: boolean; conversationUrl?: string | null }>;
  approvePlan(input: {
    conversationId: string;
    taskId?: string | null;
    expectedRevisionHash?: string | null;
    approvalChallenge?: ApprovalChallenge;
    approvalGrant?: string;
    approvalAuthority?: ApprovalGrantAuthority;
    principal?: string;
    session?: string;
  }): Promise<WorkApprovalResult>;
  interruptTurn(input: {
    conversationId: string;
    taskId?: string | null;
    turnId?: string | null;
  }): Promise<WorkInterruptResult>;
  pauseTurn?(input: {
    conversationId: string;
    taskId?: string | null;
    turnId?: string | null;
  }): Promise<WorkTransitionResult>;
  resumeTurn?(input: {
    conversationId: string;
    taskId?: string | null;
    turnId?: string | null;
  }): Promise<WorkTransitionResult>;
}

function identityOf(snapshot: WorkSnapshot): WorkIdentity {
  return {
    taskId: snapshot.taskId,
    conversationId: snapshot.conversationId,
    turnId: snapshot.turn?.id ?? null,
    revisionHash:
      snapshot.revisionHash ?? snapshot.turn?.revisionHash ?? snapshot.plan?.revisionHash ?? null,
    deliverables: snapshot.deliverables,
    provenance: snapshot.provenance,
  };
}

function revisionOf(snapshot: WorkSnapshot): string | null {
  return (
    snapshot.revisionHash ?? snapshot.turn?.revisionHash ?? snapshot.plan?.revisionHash ?? null
  );
}

function sameIdentity(
  snapshot: WorkSnapshot,
  conversationId: string,
  taskId?: string | null,
  turnId?: string | null,
): boolean {
  return (
    snapshot.conversationId === conversationId &&
    (taskId === undefined || snapshot.taskId === taskId) &&
    (turnId === undefined || snapshot.turn?.id === turnId)
  );
}

export interface WorkAnswerResult extends WorkIdentity {
  state: WorkState;
  accepted: boolean;
  reason?: string;
}

export class ChatgptWorkService {
  constructor(
    private readonly driver: WorkBrowserDriver,
    private readonly logger: BrowserLogger = (() => undefined) as BrowserLogger,
    private readonly approvalAuthority?: ApprovalGrantAuthority,
    private readonly principal?: string,
    private readonly session?: string,
  ) {}

  async start(input: {
    prompt: string;
    conversationId?: string | null;
    taskId?: string | null;
  }): Promise<WorkStartResult> {
    if (!input.prompt.trim()) {
      return {
        state: "requires_action",
        conversationId: input.conversationId ?? null,
        turnId: null,
        conversationUrl: null,
        accepted: false,
      };
    }
    const mode = await this.driver.ensureWorkMode();
    if (mode === "unsupported") {
      this.logger("ChatGPT Work start unsupported");
      return {
        state: "unsupported",
        conversationId: input.conversationId ?? null,
        turnId: null,
        conversationUrl: null,
        accepted: false,
      };
    }
    const expectedConversationId = input.conversationId ?? undefined;
    const before = await this.driver.readSnapshot(expectedConversationId, input.taskId);
    if (
      before.state === "conflict" ||
      before.mode !== "work" ||
      (expectedConversationId !== undefined && before.conversationId !== expectedConversationId)
    ) {
      this.logger("ChatGPT Work start identity conflict");
      return {
        ...identityOf(before),
        state: before.state === "conflict" ? "conflict" : "unsupported",
        conversationUrl: before.url || null,
        accepted: false,
      };
    }
    const submitted = await this.driver.submitPrompt(input.prompt);
    const after = await this.driver.readSnapshot(expectedConversationId, input.taskId);
    const existingConversationMismatch =
      expectedConversationId !== undefined &&
      !sameIdentity(after, expectedConversationId, input.taskId);
    const suppliedTaskMismatch =
      expectedConversationId === undefined &&
      input.taskId !== undefined &&
      after.taskId !== input.taskId;
    if (existingConversationMismatch || suppliedTaskMismatch) {
      return {
        ...identityOf(after),
        state: "conflict",
        conversationUrl: after.url || submitted.conversationUrl || null,
        accepted: false,
        reason: existingConversationMismatch ? "conversation-mismatch" : "task-mismatch",
      };
    }
    return {
      ...identityOf(after),
      state: submitted.accepted
        ? after.state === "unsupported"
          ? "submitted"
          : after.state
        : "requires_action",
      conversationUrl: (submitted.conversationUrl ?? after.url) || null,
      accepted: submitted.accepted,
    };
  }

  status(
    input: { conversationId?: string | null; taskId?: string | null } = {},
  ): Promise<WorkSnapshot> {
    return this.driver.readSnapshot(input.conversationId, input.taskId);
  }

  async answer(input: {
    conversationId: string;
    taskId?: string | null;
    questionId?: string | null;
    answer: string;
    turnId?: string | null;
    expectedRevisionHash?: string | null;
  }): Promise<WorkAnswerResult> {
    const before = await this.driver.readSnapshot(input.conversationId, input.taskId);
    const identity = identityOf(before);
    if (before.state === "conflict" || before.conversationId !== input.conversationId)
      return { ...identity, state: "conflict", accepted: false, reason: "conversation-mismatch" };
    if (input.taskId !== undefined && before.taskId !== input.taskId)
      return {
        ...identity,
        state: "conflict",
        accepted: false,
        reason: "task-question-revision-mismatch",
      };
    if (
      input.expectedRevisionHash !== undefined &&
      revisionOf(before) !== input.expectedRevisionHash
    )
      return {
        ...identity,
        state: "conflict",
        accepted: false,
        reason: "task-question-revision-mismatch",
      };
    if (before.state !== "waiting_for_user_input")
      return {
        ...identity,
        state: "requires_action",
        accepted: false,
        reason: "user-question-not-active",
      };
    if (input.questionId !== undefined && before.userQuestion?.id !== input.questionId)
      return {
        ...identity,
        state: "conflict",
        accepted: false,
        reason: "task-question-revision-mismatch",
      };
    if (input.turnId !== undefined && input.turnId !== before.turn?.id)
      return { ...identity, state: "conflict", accepted: false, reason: "turn-mismatch" };
    if (!input.answer.trim())
      return { ...identity, state: "requires_action", accepted: false, reason: "answer-empty" };
    const submitted = await this.driver.submitPrompt(input.answer);
    const after = await this.driver.readSnapshot(input.conversationId, input.taskId);
    if (!sameIdentity(after, input.conversationId, input.taskId, before.turn?.id))
      return {
        ...identityOf(after),
        state: "conflict",
        accepted: false,
        reason: "task-question-revision-mismatch",
      };
    return {
      ...identityOf(after),
      state: submitted.accepted ? after.state : "requires_action",
      accepted: submitted.accepted,
      reason: submitted.accepted ? undefined : "submission-not-accepted",
    };
  }

  async approve(input: {
    conversationId: string;
    taskId?: string | null;
    expectedRevisionHash?: string | null;
    approvalChallenge?: ApprovalChallenge;
    approvalGrant?: string;
    dryRun?: boolean;
  }): Promise<WorkApprovalResult> {
    const before = await this.driver.readSnapshot(input.conversationId, input.taskId);
    const identity = identityOf(before);
    const plan = before.plan;
    const challenge = plan?.revisionHash
      ? bindApprovalChallenge(
          createWorkApprovalChallenge(input.conversationId, plan.revisionHash),
          input.approvalChallenge,
        )
      : null;
    if (before.state === "conflict" || before.conversationId !== input.conversationId)
      return {
        ...identity,
        state: "conflict",
        dryRun: Boolean(input.dryRun),
        approvalChallenge: challenge,
        reason: "conversation-mismatch",
      };
    if (input.taskId !== undefined && before.taskId !== input.taskId)
      return {
        ...identity,
        state: "conflict",
        dryRun: Boolean(input.dryRun),
        approvalChallenge: challenge,
        reason: "task-mismatch",
      };
    const currentRevisionHash = revisionOf(before);
    if (
      input.expectedRevisionHash !== undefined &&
      currentRevisionHash !== input.expectedRevisionHash
    )
      return {
        ...identity,
        state: "conflict",
        dryRun: Boolean(input.dryRun),
        approvalChallenge: challenge,
        reason: "revision-mismatch",
        plan: plan ?? undefined,
      };
    if (input.dryRun)
      return {
        ...identity,
        state: "waiting_for_plan_approval",
        dryRun: true,
        approvalChallenge: challenge,
        plan: plan ?? undefined,
      };
    if (!plan || !plan.revisionHash || plan.unknown || plan.consequential || plan.externalWrite)
      return {
        ...identity,
        state: "requires_action",
        dryRun: false,
        approvalChallenge: challenge,
        reason: "unknown-or-consequential-plan",
        plan: plan ?? undefined,
      };
    if (!challenge || !this.approvalAuthority)
      return {
        ...identity,
        state: "requires_action",
        dryRun: false,
        approvalChallenge: challenge,
        reason: "approval-authority-unavailable",
        plan,
      };
    const approved = await this.driver.approvePlan({
      conversationId: input.conversationId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.expectedRevisionHash === undefined
        ? {}
        : { expectedRevisionHash: input.expectedRevisionHash }),
      approvalChallenge: challenge,
      approvalGrant: input.approvalGrant,
      approvalAuthority: this.approvalAuthority,
      principal: this.principal,
      session: this.session,
    });
    const after = await this.driver.readSnapshot(input.conversationId, input.taskId);
    return sameIdentity(after, input.conversationId, input.taskId)
      ? { ...approved, ...identityOf(after), state: after.state, approvalChallenge: challenge }
      : {
          ...identityOf(after),
          state: "conflict",
          dryRun: false,
          approvalChallenge: challenge,
          reason: "conversation-or-task-mismatch",
          plan: after.plan ?? plan,
        };
  }

  async interrupt(input: {
    conversationId: string;
    taskId?: string | null;
    turnId?: string | null;
  }): Promise<WorkInterruptResult> {
    const before = await this.driver.readSnapshot(input.conversationId, input.taskId);
    const identity = identityOf(before);
    if (before.state === "conflict" || before.conversationId !== input.conversationId)
      return { ...identity, state: "conflict", verified: false, reason: "conversation-mismatch" };
    if (input.taskId !== undefined && before.taskId !== input.taskId)
      return { ...identity, state: "conflict", verified: false, reason: "task-mismatch" };
    if (!before.turn?.active)
      return {
        ...identity,
        state: before.state,
        verified: before.state === "interrupted",
        reason: "turn-not-active",
      };
    if (input.turnId !== undefined && input.turnId !== before.turn.id)
      return { ...identity, state: "conflict", verified: false, reason: "turn-mismatch" };
    return this.driver.interruptTurn({
      conversationId: input.conversationId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      turnId: before.turn.id,
    });
  }

  async pause(input: {
    conversationId: string;
    taskId?: string | null;
    turnId?: string | null;
  }): Promise<WorkTransitionResult> {
    const before = await this.driver.readSnapshot(input.conversationId, input.taskId);
    const identity = identityOf(before);
    if (!sameIdentity(before, input.conversationId, input.taskId, input.turnId))
      return { ...identity, state: "conflict", verified: false, reason: "identity-mismatch" };
    if (!before.turn?.active)
      return {
        ...identity,
        state: before.state,
        lifecycle: before.lifecycle,
        paused: before.paused,
        verified: false,
        reason: "turn-not-active",
      };
    if (!this.driver.pauseTurn)
      return {
        ...identity,
        state: "requires_action",
        verified: false,
        reason: "pause-control-unavailable",
      };
    await this.driver.pauseTurn({
      conversationId: input.conversationId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    });
    const after = await this.driver.readSnapshot(input.conversationId, input.taskId);
    const verified =
      sameIdentity(after, input.conversationId, input.taskId, input.turnId) &&
      after.paused === true &&
      after.lifecycle === "paused";
    return {
      ...identityOf(after),
      state: verified ? after.state : "requires_action",
      lifecycle: after.lifecycle,
      paused: after.paused,
      verified,
      reason: verified ? undefined : "pause-not-verified",
    };
  }

  async resume(input: {
    conversationId: string;
    taskId?: string | null;
    turnId?: string | null;
  }): Promise<WorkTransitionResult> {
    const before = await this.driver.readSnapshot(input.conversationId, input.taskId);
    const identity = identityOf(before);
    if (!sameIdentity(before, input.conversationId, input.taskId, input.turnId))
      return { ...identity, state: "conflict", verified: false, reason: "identity-mismatch" };
    if (before.paused !== true || before.lifecycle !== "paused")
      return {
        ...identity,
        state: before.state,
        lifecycle: before.lifecycle,
        paused: before.paused,
        verified: false,
        reason: "pause-not-observed",
      };
    if (!this.driver.resumeTurn)
      return {
        ...identity,
        state: "requires_action",
        verified: false,
        reason: "resume-control-unavailable",
      };
    await this.driver.resumeTurn({
      conversationId: input.conversationId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    });
    const after = await this.driver.readSnapshot(input.conversationId, input.taskId);
    const verified =
      sameIdentity(after, input.conversationId, input.taskId, input.turnId) &&
      after.paused !== true &&
      after.lifecycle === "working" &&
      after.turn?.active === true;
    return {
      ...identityOf(after),
      state: verified ? after.state : "requires_action",
      lifecycle: after.lifecycle,
      paused: after.paused,
      verified,
      reason: verified ? undefined : "resume-not-verified",
    };
  }
}

export interface WorkErrorClassification {
  code: "partial" | "error" | "rate-limited" | "disconnected" | "recovery";
  retryable: boolean;
  retryAfterMs?: number;
  message: string;
}

function retryAfterMs(message: string): number | undefined {
  const seconds = message.match(/retry[- ]after[^\d]*(\d+(?:\.\d+)?)\s*s/i)?.[1];
  if (seconds) return Math.max(0, Math.ceil(Number(seconds) * 1000));
  const milliseconds = message.match(/retry[- ]after[^\d]*(\d+)\s*ms/i)?.[1];
  return milliseconds ? Math.max(0, Number(milliseconds)) : undefined;
}

export function classifyWorkError(error: unknown): WorkErrorClassification {
  const message = error instanceof Error ? error.message : String(error ?? "Work failed");
  const lower = message.toLowerCase();
  if (lower.includes("partial"))
    return { code: "partial", retryable: false, message: "ChatGPT Work returned partial output." };
  if (lower.includes("recover"))
    return {
      code: "recovery",
      retryable: true,
      message: "ChatGPT Work requires recovery on the same task and turn.",
    };
  if (lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("429"))
    return {
      code: "rate-limited",
      retryable: true,
      retryAfterMs: retryAfterMs(message),
      message: "ChatGPT Work is rate limited; retry after the supplied delay.",
    };
  if (
    lower.includes("disconnect") ||
    lower.includes("target closed") ||
    lower.includes("websocket") ||
    lower.includes("connection lost")
  )
    return {
      code: "disconnected",
      retryable: true,
      message: "The ChatGPT browser connection was lost; recover the same task and turn.",
    };
  return {
    code: "error",
    retryable: false,
    message: "ChatGPT Work failed without exposing sensitive browser details.",
  };
}

export function createRuntimeWorkService(options: {
  Runtime: ChromeClient["Runtime"];
  Input: ChromeClient["Input"];
  timeoutMs: number;
  logger: BrowserLogger;
  approvalAuthority?: ApprovalGrantAuthority;
  principal?: string;
  session?: string;
}): ChatgptWorkService {
  const driver: WorkBrowserDriver = {
    ensureWorkMode: () =>
      ensureRequestedChatGptMode(
        options.Runtime,
        options.Input,
        options.timeoutMs,
        options.logger,
        "work",
      ),
    readSnapshot: (expectedConversationId, expectedTaskId) =>
      readWorkSnapshot(options.Runtime, expectedConversationId, expectedTaskId),
    submitPrompt: async (prompt) => {
      await submitPrompt(
        { runtime: options.Runtime, input: options.Input, inputTimeoutMs: options.timeoutMs },
        prompt,
        options.logger,
      );
      const snapshot = await readWorkSnapshot(options.Runtime);
      return { accepted: true, conversationUrl: snapshot.url || null };
    },
    approvePlan: (input) =>
      approveWorkPlan({ Runtime: options.Runtime, Input: options.Input, ...input }),
    interruptTurn: (input) =>
      interruptWorkTurn({ Runtime: options.Runtime, Input: options.Input, ...input }),
  };
  return new ChatgptWorkService(
    driver,
    options.logger,
    options.approvalAuthority,
    options.principal,
    options.session,
  );
}

export function classifyWorkRuntimeSnapshot(
  raw: unknown,
  expectedConversationId?: string | null,
  expectedTaskId?: string | null,
): WorkSnapshot {
  return classifyWorkSnapshot(raw, expectedConversationId, expectedTaskId);
}
