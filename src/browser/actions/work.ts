import type { ChromeClient, BrowserLogger, BrowserResponseProvenance } from "../types.js";
import { delay } from "../utils.js";
import { ensureRequestedChatGptMode } from "./navigation.js";
import { submitPrompt } from "./promptComposer.js";
import {
  ApprovalGrantAuthority,
  bindApprovalChallenge,
  createApprovalChallenge,
  type ApprovalChallenge,
} from "../approvalToken.js";

export const WORK_APPROVAL_ACTION = "approve" as const;
export type WorkApprovalAction = typeof WORK_APPROVAL_ACTION;

export const WORK_STATES = [
  "queued",
  "submitted",
  "running",
  "waiting_for_plan_approval",
  "waiting_for_user_input",
  "waiting_for_confirmation",
  "completed",
  "interrupted",
  "requires_action",
  "unsupported",
  "conflict",
] as const;
export type WorkState = (typeof WORK_STATES)[number];

export type WorkLifecycle =
  | "working"
  | "paused"
  | "partial"
  | "error"
  | "rate-limited"
  | "disconnected"
  | "recovery";

export interface WorkDeliverableSnapshot {
  id: string;
  name?: string | null;
  size: number;
  mimeType: string;
  sha256: string;
  conversationId?: string | null;
  taskId?: string | null;
  turnId?: string | null;
  revisionHash?: string | null;
  provenance?: BrowserResponseProvenance;
}
export interface WorkFailureSnapshot {
  code: "partial" | "error" | "rate-limited" | "disconnected" | "recovery" | "unknown";
  message?: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export interface WorkPlanSnapshot {
  revisionHash: string | null;
  action?: string | null;
  summary?: string | null;
  consequential?: boolean;
  externalWrite?: boolean;
  unknown?: boolean;
  approvePoint?: { x: number; y: number } | null;
}

export interface WorkUserQuestionSnapshot {
  id?: string | null;
  question?: string | null;
  answerPoint?: { x: number; y: number } | null;
}

export interface WorkTurnSnapshot {
  id: string | null;
  revisionHash?: string | null;
  active: boolean;
}

export interface WorkSnapshot {
  url: string;
  conversationId: string | null;
  mode: "chat" | "work" | "unknown";
  controls: { chat: boolean; work: boolean; workSelected: boolean };
  state: WorkState;
  turn: WorkTurnSnapshot | null;
  plan: WorkPlanSnapshot | null;
  userQuestion: WorkUserQuestionSnapshot | null;
  taskId?: string | null;
  revisionHash?: string | null;
  lifecycle?: WorkLifecycle;
  paused?: boolean;
  deliverables?: WorkDeliverableSnapshot[];
  provenance?: BrowserResponseProvenance[];
  failure?: WorkFailureSnapshot;
  recovery?: { recoverable: boolean; retryAfterMs?: number; guidance?: string };
  reason?: string;
}

type RawWorkSnapshot = {
  url?: unknown;
  href?: unknown;
  conversationId?: unknown;
  taskId?: unknown;
  revisionHash?: unknown;
  mode?: unknown;
  status?: unknown;
  state?: unknown;
  lifecycle?: unknown;
  paused?: unknown;
  controls?: {
    chat?: unknown;
    work?: unknown;
    workSelected?: unknown;
    chatSelected?: unknown;
  };
  workSelected?: unknown;
  chatSelected?: unknown;
  turn?: { id?: unknown; revisionHash?: unknown; active?: unknown } | null;
  activeTurnId?: unknown;
  active?: unknown;
  plan?: {
    revisionHash?: unknown;
    revision?: unknown;
    action?: unknown;
    summary?: unknown;
    consequential?: unknown;
    externalWrite?: unknown;
    unknown?: unknown;
    approvePoint?: { x?: unknown; y?: unknown } | null;
  } | null;
  userQuestion?: {
    id?: unknown;
    question?: unknown;
    answerPoint?: { x?: unknown; y?: unknown } | null;
  } | null;
  question?: unknown;
  approvePoint?: { x?: unknown; y?: unknown } | null;
  interruptPoint?: { x?: unknown; y?: unknown } | null;
  dialog?: { kind?: unknown; unknown?: unknown; external?: unknown } | null;
  deliverables?: unknown;
  provenance?: unknown;
  failure?: {
    code?: unknown;
    message?: unknown;
    retryable?: unknown;
    retryAfterMs?: unknown;
  } | null;
  recovery?: { recoverable?: unknown; retryAfterMs?: unknown; guidance?: unknown } | null;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function point(
  value: { x?: unknown; y?: unknown } | null | undefined,
): { x: number; y: number } | null {
  return typeof value?.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y)
    ? { x: value.x, y: value.y }
    : null;
}

export function extractWorkConversationId(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(/^\/c\/([A-Za-z0-9-]+)(?:\/|$)/);
    return match?.[1] ?? null;
  } catch {
    const match = value.match(/\/c\/([A-Za-z0-9-]+)(?:\/|$)/);
    return match?.[1] ?? null;
  }
}

function normalizeLifecycle(value: unknown): WorkLifecycle | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[ _]+/g, "-");
  return [
    "working",
    "paused",
    "partial",
    "error",
    "rate-limited",
    "disconnected",
    "recovery",
  ].includes(normalized)
    ? (normalized as WorkLifecycle)
    : undefined;
}

function asFiniteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeProvenance(value: unknown): BrowserResponseProvenance | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const source = candidate.source === "chatgpt-dom" ? candidate.source : null;
  const capturedAt = asString(candidate.capturedAt);
  if (!source || !capturedAt) return null;
  return {
    source,
    capturedAt,
    ...(asString(candidate.conversationUrl)
      ? { conversationUrl: asString(candidate.conversationUrl)! }
      : {}),
    ...(asString(candidate.conversationId)
      ? { conversationId: asString(candidate.conversationId)! }
      : {}),
    ...(asString(candidate.turnId) ? { turnId: asString(candidate.turnId)! } : {}),
    ...(asString(candidate.messageId) ? { messageId: asString(candidate.messageId)! } : {}),
    ...(typeof candidate.turnIndex === "number" && Number.isInteger(candidate.turnIndex)
      ? { turnIndex: candidate.turnIndex }
      : {}),
  };
}

function normalizeDeliverables(value: unknown): WorkDeliverableSnapshot[] {
  const entries: Array<[string | null, unknown]> = Array.isArray(value)
    ? value.map((item) => [null, item])
    : value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, item])
      : [];
  return entries.flatMap(([key, item]) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    const id = asString(candidate.id) ?? key;
    const size = asFiniteNonNegative(candidate.size ?? candidate.byteSize);
    const mimeType = asString(candidate.mimeType ?? candidate.mime);
    const sha256 = asString(candidate.sha256 ?? candidate.hash);
    if (!id || size === null || !mimeType || !sha256) return [];
    const itemProvenance = normalizeProvenance(candidate.provenance);
    return [
      {
        id,
        name: asString(candidate.name ?? candidate.fileName),
        size,
        mimeType,
        sha256,
        conversationId: asString(candidate.conversationId),
        taskId: asString(candidate.taskId),
        turnId: asString(candidate.turnId),
        revisionHash: asString(candidate.revisionHash),
        ...(itemProvenance ? { provenance: itemProvenance } : {}),
      },
    ];
  });
}

export function createWorkApprovalChallenge(
  conversationId: string,
  planRevisionHash: string,
  expiry = Date.now() + 5 * 60 * 1000,
): ApprovalChallenge {
  return createApprovalChallenge({
    operation: WORK_APPROVAL_ACTION,
    target: conversationId,
    revision: planRevisionHash,
    payload: { conversationId },
    expiry,
  });
}

function normalizeState(value: unknown): WorkState | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[ -]+/g, "_");
  return (WORK_STATES as readonly string[]).includes(normalized) ? (normalized as WorkState) : null;
}

function inferState(
  raw: RawWorkSnapshot,
  mode: WorkSnapshot["mode"],
  plan: WorkPlanSnapshot | null,
): WorkState {
  const unknownExternalDialog =
    raw.dialog?.unknown === true ||
    (raw.dialog?.kind === "external" && raw.dialog?.external !== false);
  if (unknownExternalDialog) return "requires_action";
  const explicit = normalizeState(raw.state ?? raw.status);
  if (explicit) return explicit;
  if (mode !== "work") return mode === "unknown" ? "unsupported" : "conflict";
  if (plan && !plan.unknown && plan.revisionHash && !plan.consequential && !plan.externalWrite) {
    return "waiting_for_plan_approval";
  }
  if (raw.userQuestion || raw.question) return "waiting_for_user_input";
  if (raw.active === false || raw.turn?.active === false) return "completed";
  if (raw.active || raw.turn?.active) return "running";
  return "submitted";
}

function failureSnapshot(raw: RawWorkSnapshot["failure"]): WorkFailureSnapshot | undefined {
  if (!raw) return undefined;
  const code = normalizeLifecycle(raw.code);
  const allowed =
    code === "partial" ||
    code === "error" ||
    code === "rate-limited" ||
    code === "disconnected" ||
    code === "recovery";
  if (!allowed)
    return {
      code: "unknown",
      message: asString(raw.message) ?? undefined,
      retryable: Boolean(raw.retryable),
    };
  const retryAfterMs = asFiniteNonNegative(raw.retryAfterMs);
  return {
    code,
    message: asString(raw.message) ?? undefined,
    retryable: Boolean(raw.retryable),
    ...(retryAfterMs === null ? {} : { retryAfterMs }),
  };
}

/** Classifies only server-backed Work UI evidence; unrecognised UI is never treated as Chat. */
export function classifyWorkSnapshot(
  rawValue: unknown,
  expectedConversationId?: string | null,
  expectedTaskId?: string | null,
): WorkSnapshot {
  const raw = (rawValue && typeof rawValue === "object" ? rawValue : {}) as RawWorkSnapshot;
  const url = asString(raw.url ?? raw.href) ?? "";
  const conversationId = asString(raw.conversationId) ?? extractWorkConversationId(url);
  const taskId = asString(raw.taskId);
  const controls = {
    chat: Boolean(raw.controls?.chat ?? raw.chatSelected),
    work: Boolean(raw.controls?.work ?? raw.workSelected),
    workSelected: Boolean(raw.controls?.workSelected ?? raw.workSelected),
  };
  const modeValue = asString(raw.mode)?.toLowerCase();
  const mode: WorkSnapshot["mode"] =
    controls.workSelected || modeValue === "work"
      ? "work"
      : Boolean(raw.controls?.chatSelected ?? raw.chatSelected) || modeValue === "chat"
        ? "chat"
        : "unknown";
  const planRaw = raw.plan;
  const plan = planRaw
    ? {
        revisionHash: asString(planRaw.revisionHash ?? planRaw.revision),
        action: asString(planRaw.action),
        summary: asString(planRaw.summary),
        consequential: Boolean(planRaw.consequential),
        externalWrite: Boolean(planRaw.externalWrite),
        unknown: Boolean(planRaw.unknown),
        approvePoint: point(planRaw.approvePoint),
      }
    : null;
  const questionRaw = raw.userQuestion ?? (raw.question ? { question: raw.question } : null);
  const userQuestion = questionRaw
    ? {
        id: asString(questionRaw.id),
        question: asString(questionRaw.question),
        answerPoint: point(questionRaw.answerPoint),
      }
    : null;
  const turn =
    raw.turn || raw.activeTurnId || raw.active !== undefined
      ? {
          id: asString(raw.turn?.id ?? raw.activeTurnId),
          revisionHash: asString(raw.turn?.revisionHash),
          active: Boolean(raw.turn?.active ?? raw.active),
        }
      : null;
  const revisionHash =
    asString(raw.revisionHash) ?? turn?.revisionHash ?? plan?.revisionHash ?? null;
  const lifecycle =
    normalizeLifecycle(raw.lifecycle) ?? (raw.paused === true ? "paused" : undefined);
  const paused = raw.paused === true || lifecycle === "paused";
  const provenanceValues = Array.isArray(raw.provenance)
    ? raw.provenance
    : raw.provenance
      ? [raw.provenance]
      : [];
  const provenance = provenanceValues.flatMap((item) => {
    const normalized = normalizeProvenance(item);
    return normalized ? [normalized] : [];
  });
  const identityConflict =
    expectedConversationId !== undefined && conversationId !== expectedConversationId;
  const taskConflict = expectedTaskId !== undefined && taskId !== expectedTaskId;
  const unknownExternalDialog =
    raw.dialog?.unknown === true ||
    (raw.dialog?.kind === "external" && raw.dialog?.external !== false);
  const state = identityConflict || taskConflict ? "conflict" : inferState(raw, mode, plan);
  const reason = identityConflict
    ? "conversation-mismatch"
    : taskConflict
      ? "task-mismatch"
      : unknownExternalDialog
        ? "unknown-external-dialog"
        : undefined;
  return {
    url,
    conversationId,
    mode,
    controls,
    state,
    turn,
    plan,
    userQuestion,
    taskId,
    revisionHash,
    ...(lifecycle ? { lifecycle } : {}),
    ...(paused ? { paused } : {}),
    deliverables: normalizeDeliverables(raw.deliverables),
    provenance,
    ...(failureSnapshot(raw.failure) ? { failure: failureSnapshot(raw.failure) } : {}),
    ...(raw.recovery && typeof raw.recovery === "object"
      ? {
          recovery: {
            recoverable: Boolean(raw.recovery.recoverable),
            ...(asFiniteNonNegative(raw.recovery.retryAfterMs) === null
              ? {}
              : { retryAfterMs: asFiniteNonNegative(raw.recovery.retryAfterMs)! }),
            ...(asString(raw.recovery.guidance)
              ? { guidance: asString(raw.recovery.guidance)! }
              : {}),
          },
        }
      : {}),
    reason,
  };
}

/** Fixed, allowlisted DOM probe. It intentionally returns no prompt/title/private text. */
export function buildWorkSnapshotExpression(): string {
  return `(() => {
    const normalize = (value) => String(value ?? '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const visible = (node) => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const selected = (node) => node?.getAttribute?.('aria-checked') === 'true' || node?.getAttribute?.('data-state') === 'on';
    const idMatch = String(location?.pathname || '').match(/^\\/c\\/([A-Za-z0-9-]+)(?:\\/|$)/);
    const conversationId = idMatch?.[1] || null;
    const radios = Array.from(document.querySelectorAll('button[role="radio"]')).filter(visible);
    const named = (label) => radios.find((node) => normalize(node.textContent) === label);
    const chat = named('chat');
    const work = named('work');
    const testid = (value) => document.querySelector('[data-testid="' + value + '"]');
    const aria = (value) => document.querySelector('[aria-label="' + value + '"]');
    const workControl = work || testid('work-mode') || testid('work-mode-control') || aria('Work') || aria('Work mode');
    const statusNode = testid('work-status') || document.querySelector('[role="status"]') || document.querySelector('[aria-live="polite"]');
    const planNode = testid('work-plan') || testid('work-plan-card') || testid('work-approval-card');
    const questionNode = testid('work-user-question') || testid('work-question');
    const stopNode = testid('work-stop') || aria('Stop Work') || aria('Stop');
    const pointOf = (node) => {
      if (!node || !visible(node)) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    const text = (node) => normalize(node?.textContent);
    const planRevision = planNode?.getAttribute?.('data-plan-revision') || planNode?.getAttribute?.('data-revision-hash') || null;
    const planAction = planNode?.getAttribute?.('data-action') || null;
    const planText = text(planNode);
    const planUnknown = !planNode || !planRevision || !planAction;
    const planConsequential = Boolean(planNode?.getAttribute?.('data-consequential') === 'true' || /write|delete|send|purchase|external|publish/.test(planText));
    const approve = planNode?.querySelector?.('[data-testid="work-approve"], [aria-label="Approve plan"]');
    return {
      url: String(location?.href || ''),
      conversationId,
      mode: workControl && selected(workControl) ? 'work' : chat && selected(chat) ? 'chat' : 'unknown',
      controls: { chat: Boolean(chat), work: Boolean(workControl), chatSelected: Boolean(chat && selected(chat)), workSelected: Boolean(workControl && selected(workControl)) },
      status: text(statusNode),
      active: Boolean(stopNode && visible(stopNode)),
      turn: { id: statusNode?.getAttribute?.('data-turn-id') || null, active: Boolean(stopNode && visible(stopNode)) },
      plan: planNode ? { revisionHash: planRevision, action: planAction, summary: planText || null, consequential: planConsequential, externalWrite: planConsequential, unknown: planUnknown, approvePoint: pointOf(approve) } : null,
      userQuestion: questionNode ? { id: questionNode.getAttribute?.('data-question-id') || null, answerPoint: pointOf(questionNode) } : null,
      interruptPoint: pointOf(stopNode),
    };
  })()`;
}

export function buildWorkSnapshotExpressionForTest(): string {
  return buildWorkSnapshotExpression();
}

export async function readWorkSnapshot(
  Runtime: ChromeClient["Runtime"],
  expectedConversationId?: string | null,
  expectedTaskId?: string | null,
): Promise<WorkSnapshot> {
  const outcome = await Runtime.evaluate({
    expression: buildWorkSnapshotExpression(),
    returnByValue: true,
  });
  return classifyWorkSnapshot(outcome.result?.value, expectedConversationId, expectedTaskId);
}

async function clickPoint(
  Input: ChromeClient["Input"],
  click: { x: number; y: number },
): Promise<void> {
  await Input.dispatchMouseEvent({ type: "mouseMoved", x: click.x, y: click.y });
  await Input.dispatchMouseEvent({
    type: "mousePressed",
    x: click.x,
    y: click.y,
    button: "left",
    clickCount: 1,
  });
  await Input.dispatchMouseEvent({
    type: "mouseReleased",
    x: click.x,
    y: click.y,
    button: "left",
    clickCount: 1,
  });
}

export interface WorkIdentity {
  taskId?: string | null;
  conversationId: string | null;
  turnId: string | null;
  revisionHash?: string | null;
  deliverables?: WorkDeliverableSnapshot[];
  provenance?: BrowserResponseProvenance[];
}

function snapshotIdentity(snapshot: WorkSnapshot): WorkIdentity {
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

export interface WorkStartResult extends WorkIdentity {
  state: WorkState;
  conversationUrl: string | null;
  accepted: boolean;
  reason?: string;
}

export async function startWorkTurn(options: {
  Runtime: ChromeClient["Runtime"];
  Input: ChromeClient["Input"];
  prompt: string;
  timeoutMs: number;
  logger: BrowserLogger;
  expectedConversationId?: string | null;
  expectedTaskId?: string | null;
  pollMs?: number;
}): Promise<WorkStartResult> {
  const mode = await ensureRequestedChatGptMode(
    options.Runtime,
    options.Input,
    options.timeoutMs,
    options.logger,
    "work",
    { pollMs: options.pollMs },
  );
  if (mode === "unsupported") {
    return {
      state: "unsupported",
      conversationId: null,
      turnId: null,
      conversationUrl: null,
      accepted: false,
    };
  }
  const selected = await readWorkSnapshot(
    options.Runtime,
    options.expectedConversationId,
    options.expectedTaskId,
  );
  if (selected.mode !== "work" || selected.state === "conflict") {
    return {
      ...snapshotIdentity(selected),
      state: selected.state === "conflict" ? "conflict" : "unsupported",
      conversationUrl: selected.url || null,
      accepted: false,
    };
  }
  await submitPrompt(
    { runtime: options.Runtime, input: options.Input, inputTimeoutMs: options.timeoutMs },
    options.prompt,
    options.logger,
  );
  const submitted = await readWorkSnapshot(
    options.Runtime,
    selected.conversationId,
    selected.taskId,
  );
  return {
    ...snapshotIdentity(submitted),
    state: submitted.state === "unsupported" ? "submitted" : submitted.state,
    conversationUrl: submitted.url || null,
    accepted: true,
  };
}

export interface WorkApprovalResult extends WorkIdentity {
  state: WorkState;
  dryRun: boolean;
  approvalChallenge: ApprovalChallenge | null;
  reason?: string;
  plan?: WorkPlanSnapshot;
}

export async function approveWorkPlan(options: {
  Runtime: ChromeClient["Runtime"];
  Input: ChromeClient["Input"];
  conversationId: string;
  taskId?: string | null;
  expectedRevisionHash?: string | null;
  approvalChallenge?: ApprovalChallenge;
  approvalGrant?: string;
  approvalAuthority?: ApprovalGrantAuthority;
  principal?: string;
  session?: string;
  dryRun?: boolean;
}): Promise<WorkApprovalResult> {
  const snapshot = await readWorkSnapshot(options.Runtime, options.conversationId, options.taskId);
  const identity = snapshotIdentity(snapshot);
  const plan = snapshot.plan;
  const currentRevisionHash = snapshot.revisionHash ?? plan?.revisionHash ?? null;
  const challenge = plan?.revisionHash
    ? bindApprovalChallenge(
        createWorkApprovalChallenge(options.conversationId, plan.revisionHash),
        options.approvalChallenge,
      )
    : null;
  if (
    snapshot.state === "conflict" ||
    snapshot.conversationId !== options.conversationId ||
    (options.taskId !== undefined && snapshot.taskId !== options.taskId)
  )
    return {
      ...identity,
      state: "conflict",
      dryRun: Boolean(options.dryRun),
      approvalChallenge: challenge,
      reason: "conversation-or-task-mismatch",
    };
  if (
    options.expectedRevisionHash !== undefined &&
    currentRevisionHash !== options.expectedRevisionHash
  )
    return {
      ...identity,
      state: "conflict",
      dryRun: Boolean(options.dryRun),
      approvalChallenge: challenge,
      reason: "revision-mismatch",
      plan: plan ?? undefined,
    };
  if (options.dryRun)
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
  if (!challenge || !options.approvalAuthority)
    return {
      ...identity,
      state: "requires_action",
      dryRun: false,
      approvalChallenge: challenge,
      reason: "approval-authority-unavailable",
      plan,
    };
  const consumed = options.approvalAuthority.consumeGrant(options.approvalGrant, challenge, {
    principal: options.principal,
    session: options.session,
  });
  if (consumed.state !== "consumed")
    return {
      ...identity,
      state: "requires_action",
      dryRun: false,
      approvalChallenge: challenge,
      reason: consumed.reason,
      plan,
    };
  if (!plan.approvePoint)
    return {
      ...identity,
      state: "requires_action",
      dryRun: false,
      approvalChallenge: challenge,
      reason: "approval-control-unavailable",
      plan,
    };
  await clickPoint(options.Input, plan.approvePoint);
  const verified = await readWorkSnapshot(options.Runtime, options.conversationId, options.taskId);
  const verifiedIdentity = snapshotIdentity(verified);
  const identityChanged =
    verified.conversationId !== options.conversationId ||
    (options.taskId !== undefined && verified.taskId !== options.taskId);
  return identityChanged
    ? {
        ...verifiedIdentity,
        state: "conflict",
        dryRun: false,
        approvalChallenge: challenge,
        reason: "conversation-or-task-mismatch",
        plan: verified.plan ?? plan,
      }
    : {
        ...verifiedIdentity,
        state: verified.state,
        dryRun: false,
        approvalChallenge: challenge,
        plan: verified.plan ?? plan,
      };
}

export interface WorkInterruptResult extends WorkIdentity {
  state: WorkState;
  verified: boolean;
  reason?: string;
}

export async function interruptWorkTurn(options: {
  Runtime: ChromeClient["Runtime"];
  Input: ChromeClient["Input"];
  conversationId: string;
  taskId?: string | null;
  turnId?: string | null;
}): Promise<WorkInterruptResult> {
  const before = await readWorkSnapshot(options.Runtime, options.conversationId, options.taskId);
  const identity = snapshotIdentity(before);
  if (
    before.state === "conflict" ||
    before.conversationId !== options.conversationId ||
    (options.taskId !== undefined && before.taskId !== options.taskId)
  )
    return {
      ...identity,
      state: "conflict",
      verified: false,
      reason: "conversation-or-task-mismatch",
    };
  if (!before.turn?.active)
    return {
      ...identity,
      state: before.state,
      verified: before.state === "interrupted",
      reason: "turn-not-active",
    };
  if (options.turnId && before.turn.id !== options.turnId)
    return { ...identity, state: "conflict", verified: false, reason: "turn-mismatch" };
  const outcome = await options.Runtime.evaluate({
    expression: `(${buildWorkSnapshotExpression()}).interruptPoint`,
    returnByValue: true,
  });
  const interruptPoint = point(outcome.result?.value as { x?: unknown; y?: unknown } | null);
  if (!interruptPoint)
    return {
      ...identity,
      state: "requires_action",
      verified: false,
      reason: "interrupt-control-unavailable",
    };
  await clickPoint(options.Input, interruptPoint);
  const after = await readWorkSnapshot(options.Runtime, options.conversationId, options.taskId);
  const verified =
    !after.turn?.active &&
    after.state === "interrupted" &&
    after.conversationId === options.conversationId &&
    (options.taskId === undefined || after.taskId === options.taskId);
  return {
    ...snapshotIdentity(after),
    state: verified ? "interrupted" : "requires_action",
    verified,
    reason: verified ? undefined : "interrupt-not-verified",
  };
}

export async function waitForWorkState(
  Runtime: ChromeClient["Runtime"],
  expectedConversationId: string,
  states: readonly WorkState[],
  timeoutMs: number,
  pollMs = 200,
): Promise<WorkSnapshot> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let latest = await readWorkSnapshot(Runtime, expectedConversationId);
  while (!states.includes(latest.state) && Date.now() < deadline) {
    await delay(pollMs);
    latest = await readWorkSnapshot(Runtime, expectedConversationId);
  }
  return latest;
}

export const workApprovalChallengeForTest = createWorkApprovalChallenge;
export const classifyWorkSnapshotForTest = classifyWorkSnapshot;
