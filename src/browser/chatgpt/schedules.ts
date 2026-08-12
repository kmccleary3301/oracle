import {
  bindApprovalChallenge,
  createApprovalChallenge,
  type ApprovalChallenge,
} from "../approvalToken.js";
import type { BrowserResponseProvenance } from "../types.js";
import type {
  ChatgptScheduleConflict,
  ChatgptScheduleCreateInput,
  ChatgptScheduleDriver,
  ChatgptScheduleFailure,
  ChatgptScheduleGetResult,
  ChatgptScheduleListResult,
  ChatgptScheduleMutationInput,
  ChatgptScheduleMutationResult,
  ChatgptScheduleOperation,
  ChatgptScheduleOperationResult,
  ChatgptScheduleRecord,
  ChatgptScheduleReconcileResult,
  ChatgptScheduleRequiresAction,
  ChatgptScheduleStore,
  ChatgptScheduleState,
  ChatgptScheduleUpdateInput,
} from "./scheduleTypes.js";
import type { ChatgptScheduleServiceOptions } from "./scheduleTypes.js";
import type { ChatgptCapabilityEvidence } from "./historyTypes.js";

export type * from "./scheduleTypes.js";

export const CHATGPT_SCHEDULE_APPROVAL_OPERATIONS = {
  create: "chatgpt.schedule.create",
  update: "chatgpt.schedule.update",
  pause: "chatgpt.schedule.pause",
  resume: "chatgpt.schedule.resume",
  delete: "chatgpt.schedule.delete",
} as const;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function exact(value: unknown, label: string): string {
  if (!nonEmpty(value)) throw new Error(`${label} is required.`);
  return value.trim();
}

function safeProvenance(value: unknown): BrowserResponseProvenance[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const input = item as Partial<BrowserResponseProvenance>;
    if (input.source !== "chatgpt-dom" || !nonEmpty(input.capturedAt)) return [];
    return [
      {
        source: "chatgpt-dom",
        capturedAt: input.capturedAt,
        ...(nonEmpty(input.conversationUrl) ? { conversationUrl: input.conversationUrl } : {}),
        ...(nonEmpty(input.conversationId) ? { conversationId: input.conversationId } : {}),
        ...(nonEmpty(input.turnId) ? { turnId: input.turnId } : {}),
        ...(nonEmpty(input.messageId) ? { messageId: input.messageId } : {}),
        ...(typeof input.turnIndex === "number" ? { turnIndex: input.turnIndex } : {}),
      },
    ];
  });
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

function validRecurrence(value: unknown): ChatgptScheduleRecord["recurrence"] {
  if (!value || typeof value !== "object") throw new Error("recurrence is required");
  const input = value as Record<string, unknown>;
  const kind = input.kind;
  if (kind === "once") {
    const runAt = exact(input.runAt, "recurrence.runAt");
    if (Number.isNaN(Date.parse(runAt))) throw new Error("recurrence.runAt is invalid");
    return { kind, runAt };
  }
  if (kind === "daily") {
    const hour = Number(input.hour);
    const minute = Number(input.minute);
    if (
      !Number.isInteger(hour) ||
      hour < 0 ||
      hour > 23 ||
      !Number.isInteger(minute) ||
      minute < 0 ||
      minute > 59
    )
      throw new Error("daily recurrence time is invalid");
    return {
      kind,
      hour,
      minute,
      ...(nonEmpty(input.timezone) ? { timezone: input.timezone.slice(0, 80) } : {}),
    };
  }
  if (kind === "weekly") {
    const days = Array.isArray(input.days)
      ? [...new Set(input.days.map(Number))]
          .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
          .sort((a, b) => a - b)
      : [];
    const hour = Number(input.hour);
    const minute = Number(input.minute);
    if (
      !days.length ||
      !Number.isInteger(hour) ||
      hour < 0 ||
      hour > 23 ||
      !Number.isInteger(minute) ||
      minute < 0 ||
      minute > 59
    )
      throw new Error("weekly recurrence is invalid");
    return {
      kind,
      days,
      hour,
      minute,
      ...(nonEmpty(input.timezone) ? { timezone: input.timezone.slice(0, 80) } : {}),
    };
  }
  if (kind === "interval") {
    const everyMinutes = Number(input.everyMinutes);
    if (!Number.isInteger(everyMinutes) || everyMinutes < 1 || everyMinutes > 525_600)
      throw new Error("interval recurrence is invalid");
    return {
      kind,
      everyMinutes,
      ...(nonEmpty(input.timezone) ? { timezone: input.timezone.slice(0, 80) } : {}),
    };
  }
  throw new Error("unsupported recurrence");
}

function safeRecord(value: unknown): ChatgptScheduleRecord {
  if (!value || typeof value !== "object") throw new Error("schedule response was not an object");
  const input = value as Partial<ChatgptScheduleRecord>;
  const scheduleId = exact(input.scheduleId, "scheduleId");
  const revisionHash = exact(input.revisionHash, "revisionHash");
  const title = exact(input.title, "title").slice(0, 240);
  const prompt = exact(input.prompt, "prompt").slice(0, 100_000);
  const recurrence = validRecurrence(input.recurrence);
  const rawState = String(input.state);
  const state: ChatgptScheduleState = [
    "active",
    "paused",
    "completed",
    "deleted",
    "unknown",
  ].includes(rawState)
    ? (rawState as ChatgptScheduleState)
    : "unknown";
  const observedEvidence = Boolean(input.observedEvidence);
  return {
    scheduleId,
    revisionHash,
    title,
    prompt,
    recurrence,
    state: state === "completed" && !observedEvidence ? "unknown" : state,
    ...(input.desiredState &&
    ["active", "paused", "completed", "deleted"].includes(input.desiredState)
      ? { desiredState: input.desiredState }
      : {}),
    nextRunAt: input.nextRunAt === null || nonEmpty(input.nextRunAt) ? input.nextRunAt : null,
    lastObservedRunAt:
      input.lastObservedRunAt === null || nonEmpty(input.lastObservedRunAt)
        ? input.lastObservedRunAt
        : null,
    observedEvidence,
    capability: safeCapability(input.capability),
    provenance: safeProvenance(input.provenance),
  };
}

function challenge(
  operation: ChatgptScheduleOperation,
  target: string,
  revision: string,
  payload: unknown = {},
): ApprovalChallenge {
  return createApprovalChallenge({ operation, target, revision, payload });
}

function mutationApprovalPayload(
  operation: ChatgptScheduleOperation,
  input: ChatgptScheduleMutationInput,
): Record<string, unknown> {
  if (operation !== CHATGPT_SCHEDULE_APPROVAL_OPERATIONS.update) return {};
  const update = input as ChatgptScheduleUpdateInput;
  return {
    title: update.title === undefined ? null : exact(update.title, "title"),
    prompt: update.prompt === undefined ? null : exact(update.prompt, "prompt"),
    recurrence: update.recurrence === undefined ? null : validRecurrence(update.recurrence),
  };
}

function failure(error: unknown, scheduleId?: string): ChatgptScheduleFailure {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return {
    state: /unsupported|unavailable|not implemented|missing control/.test(message)
      ? "unsupported"
      : "requires_action",
    ...(scheduleId ? { scheduleId } : {}),
    reason: /unsupported|unavailable|not implemented|missing control/.test(message)
      ? "unsupported"
      : "schedule-operation-failed",
    provenance: [],
  };
}

function requiresAction(
  scheduleId: string | undefined,
  record: ChatgptScheduleRecord | undefined,
  reason: string,
  approvalChallenge?: ApprovalChallenge,
): ChatgptScheduleRequiresAction {
  return {
    state: "requires_action",
    ...(scheduleId ? { scheduleId } : {}),
    ...(record ? { revisionHash: record.revisionHash, schedule: record } : {}),
    ...(approvalChallenge ? { approvalChallenge } : {}),
    reason,
    provenance: record?.provenance ?? [],
  };
}

function conflict(
  scheduleId: string,
  expectedRevisionHash: string | undefined,
  record?: ChatgptScheduleRecord,
  reason: ChatgptScheduleConflict["reason"] = "revision-conflict",
): ChatgptScheduleConflict {
  return {
    state: "conflict",
    scheduleId,
    ...(expectedRevisionHash ? { expectedRevisionHash } : {}),
    ...(record ? { observedRevisionHash: record.revisionHash, schedule: record } : {}),
    reason,
    provenance: record?.provenance ?? [],
  };
}

export class MemoryChatgptScheduleStore implements ChatgptScheduleStore {
  readonly #records = new Map<string, ChatgptScheduleRecord>();
  #lock: Promise<unknown> = Promise.resolve();

  constructor(initial: ChatgptScheduleRecord[] = []) {
    for (const record of initial) this.#records.set(record.scheduleId, safeRecord(record));
  }

  load(): ChatgptScheduleRecord[] {
    return [...this.#records.values()].map((record) => ({
      ...record,
      provenance: [...record.provenance],
    }));
  }

  save(record: ChatgptScheduleRecord): void {
    this.#records.set(record.scheduleId, safeRecord(record));
  }

  remove(scheduleId: string): void {
    this.#records.delete(scheduleId);
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.#lock;
    let release!: () => void;
    this.#lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class ChatgptScheduleService {
  constructor(
    private readonly driver: ChatgptScheduleDriver,
    private readonly store: ChatgptScheduleStore = new MemoryChatgptScheduleStore(),
    private readonly options: ChatgptScheduleServiceOptions = {},
  ) {}

  async list(signal?: AbortSignal): Promise<ChatgptScheduleOperationResult> {
    try {
      const schedules = (await this.driver.list({ signal }))
        .map(safeRecord)
        .sort((a, b) => a.scheduleId.localeCompare(b.scheduleId));
      return {
        state: "ok",
        schedules,
        provenance: schedules.flatMap((record) => record.provenance).slice(0, 16),
      } satisfies ChatgptScheduleListResult;
    } catch (error) {
      return failure(error);
    }
  }

  async get(
    scheduleIdInput: string,
    signal?: AbortSignal,
  ): Promise<ChatgptScheduleOperationResult> {
    let scheduleId = "";
    try {
      scheduleId = exact(scheduleIdInput, "scheduleId");
      const schedule = safeRecord(await this.driver.get({ scheduleId, signal }));
      return {
        state: "ok",
        schedule,
        revisionHash: schedule.revisionHash,
        provenance: schedule.provenance,
      } satisfies ChatgptScheduleGetResult;
    } catch (error) {
      return failure(error, scheduleId || undefined);
    }
  }

  async create(input: ChatgptScheduleCreateInput): Promise<ChatgptScheduleOperationResult> {
    let targetId = "";
    try {
      targetId = exact(input.scheduleId ?? input.clientRequestId, "scheduleId or clientRequestId");
      const title = exact(input.title, "title");
      const prompt = exact(input.prompt, "prompt");
      const recurrence = validRecurrence(input.recurrence);
      const revisionHash = input.expectedRevisionHash?.trim() || "create";
      const approvalChallenge = bindApprovalChallenge(
        challenge(CHATGPT_SCHEDULE_APPROVAL_OPERATIONS.create, targetId, revisionHash, {
          title,
          prompt,
          recurrence,
        }),
        input.approvalChallenge,
      );
      if (input.dryRun)
        return requiresAction(targetId, undefined, "approval-required", approvalChallenge);
      if (!this.options.approvalAuthority)
        return requiresAction(
          targetId,
          undefined,
          "approval-authority-unavailable",
          approvalChallenge,
        );
      const consumed = this.options.approvalAuthority.consumeGrant(
        input.approvalGrant,
        approvalChallenge,
        { principal: this.options.principal, session: this.options.session },
      );
      if (consumed.state !== "consumed")
        return requiresAction(targetId, undefined, consumed.reason, approvalChallenge);
      if (input.signal?.aborted)
        return requiresAction(targetId, undefined, "cancellation-race", approvalChallenge);
      const created = safeRecord(
        await this.driver.create({
          scheduleId: input.scheduleId,
          clientRequestId: input.clientRequestId,
          title,
          prompt,
          recurrence,
          revisionHash,
          signal: input.signal,
        }),
      );
      if (
        created.state === "unknown" ||
        (created.state === "completed" && !created.observedEvidence)
      )
        return requiresAction(targetId, created, "create-not-verified", approvalChallenge);
      await this.store.save({
        ...created,
        desiredState: created.state === "deleted" ? "deleted" : created.state,
      });
      return {
        state: "ok",
        operation: CHATGPT_SCHEDULE_APPROVAL_OPERATIONS.create,
        schedule: created,
        revisionHash: created.revisionHash,
        changed: true,
        capability: created.capability,
        provenance: created.provenance,
      } satisfies ChatgptScheduleMutationResult;
    } catch (error) {
      return failure(error, targetId || undefined);
    }
  }

  async update(input: ChatgptScheduleUpdateInput): Promise<ChatgptScheduleOperationResult> {
    return this.mutate(input, CHATGPT_SCHEDULE_APPROVAL_OPERATIONS.update, async (before) => {
      const title = input.title === undefined ? undefined : exact(input.title, "title");
      const prompt = input.prompt === undefined ? undefined : exact(input.prompt, "prompt");
      const recurrence =
        input.recurrence === undefined ? undefined : validRecurrence(input.recurrence);
      if (title === undefined && prompt === undefined && recurrence === undefined) return before;
      return safeRecord(
        await this.driver.update({
          scheduleId: before.scheduleId,
          title,
          prompt,
          recurrence,
          revisionHash: before.revisionHash,
          signal: input.signal,
        }),
      );
    });
  }

  async pause(input: ChatgptScheduleMutationInput): Promise<ChatgptScheduleOperationResult> {
    return this.stateMutation(input, CHATGPT_SCHEDULE_APPROVAL_OPERATIONS.pause, "paused");
  }

  async resume(input: ChatgptScheduleMutationInput): Promise<ChatgptScheduleOperationResult> {
    return this.stateMutation(input, CHATGPT_SCHEDULE_APPROVAL_OPERATIONS.resume, "active");
  }

  async delete(input: ChatgptScheduleMutationInput): Promise<ChatgptScheduleOperationResult> {
    return this.mutate(
      input,
      CHATGPT_SCHEDULE_APPROVAL_OPERATIONS.delete,
      async (before) => {
        const result = await this.driver.delete({
          scheduleId: before.scheduleId,
          revisionHash: before.revisionHash,
          signal: input.signal,
        });
        if (result) return safeRecord(result);
        return { ...before, state: "deleted", desiredState: "deleted", observedEvidence: true };
      },
      "deleted",
    );
  }

  private async stateMutation(
    input: ChatgptScheduleMutationInput,
    operation: ChatgptScheduleOperation,
    state: "active" | "paused",
  ): Promise<ChatgptScheduleOperationResult> {
    return this.mutate(
      input,
      operation,
      async (before) => {
        if (before.state === state) return before;
        const result =
          state === "paused"
            ? await this.driver.pause({
                scheduleId: before.scheduleId,
                revisionHash: before.revisionHash,
                signal: input.signal,
              })
            : await this.driver.resume({
                scheduleId: before.scheduleId,
                revisionHash: before.revisionHash,
                signal: input.signal,
              });
        return safeRecord(result);
      },
      state,
    );
  }

  private async mutate(
    input: ChatgptScheduleMutationInput,
    operation: ChatgptScheduleOperation,
    action: (before: ChatgptScheduleRecord) => Promise<ChatgptScheduleRecord>,
    expectedState?: Exclude<ChatgptScheduleState, "unknown">,
  ): Promise<ChatgptScheduleOperationResult> {
    let scheduleId = "";
    try {
      scheduleId = exact(input.scheduleId, "scheduleId");
      const expectedRevisionHash = exact(input.expectedRevisionHash, "expectedRevisionHash");
      const before = safeRecord(await this.driver.get({ scheduleId, signal: input.signal }));
      if (before.revisionHash !== expectedRevisionHash)
        return conflict(scheduleId, expectedRevisionHash, before);
      const approvalChallenge = bindApprovalChallenge(
        challenge(
          operation,
          scheduleId,
          before.revisionHash,
          mutationApprovalPayload(operation, input),
        ),
        input.approvalChallenge,
      );
      if (input.dryRun)
        return requiresAction(scheduleId, before, "approval-required", approvalChallenge);
      if (!this.options.approvalAuthority)
        return requiresAction(
          scheduleId,
          before,
          "approval-authority-unavailable",
          approvalChallenge,
        );
      const consumed = this.options.approvalAuthority.consumeGrant(
        input.approvalGrant,
        approvalChallenge,
        { principal: this.options.principal, session: this.options.session },
      );
      if (consumed.state !== "consumed")
        return requiresAction(scheduleId, before, consumed.reason, approvalChallenge);
      if (input.signal?.aborted)
        return requiresAction(scheduleId, before, "cancellation-race", approvalChallenge);
      if (expectedState && before.state === expectedState) {
        await this.store.save({ ...before, desiredState: expectedState });
        return {
          state: "ok",
          operation,
          schedule: before,
          revisionHash: before.revisionHash,
          changed: false,
          capability: before.capability,
          provenance: before.provenance,
        } satisfies ChatgptScheduleMutationResult;
      }
      const after = safeRecord(await action(before));
      if (input.signal?.aborted)
        return requiresAction(scheduleId, after, "cancellation-race", approvalChallenge);
      if (expectedState && after.state !== expectedState)
        return requiresAction(scheduleId, after, "mutation-not-verified", approvalChallenge);
      if (after.state === "completed" && !after.observedEvidence)
        return requiresAction(scheduleId, after, "completion-not-observed", approvalChallenge);
      if (after.state === "unknown")
        return requiresAction(scheduleId, after, "external-ui-drift", approvalChallenge);
      await this.store.save({ ...after, desiredState: expectedState ?? after.state });
      return {
        state: "ok",
        operation,
        schedule: after,
        revisionHash: after.revisionHash,
        changed: after.revisionHash !== before.revisionHash || after.state !== before.state,
        capability: after.capability,
        provenance: after.provenance,
      } satisfies ChatgptScheduleMutationResult;
    } catch (error) {
      return failure(error, scheduleId || undefined);
    }
  }

  async reconcile(signal?: AbortSignal): Promise<ChatgptScheduleReconcileResult> {
    return this.store.withLock(async () => {
      try {
        const desired = (await this.store.load()).map(safeRecord);
        const observed = (await this.driver.list({ signal })).map(safeRecord);
        const observedById = new Map(observed.map((record) => [record.scheduleId, record]));
        const conflicts: ChatgptScheduleConflict[] = [];
        const requires: ChatgptScheduleRequiresAction[] = [];
        const output: ChatgptScheduleRecord[] = [];
        for (const local of desired) {
          if (signal?.aborted) {
            requires.push(requiresAction(local.scheduleId, local, "cancellation-race"));
            continue;
          }
          const remote = observedById.get(local.scheduleId);
          if (!remote) {
            requires.push(requiresAction(local.scheduleId, local, "external-ui-drift"));
            continue;
          }
          if (remote.revisionHash !== local.revisionHash) {
            conflicts.push(
              conflict(local.scheduleId, local.revisionHash, remote, "external-drift"),
            );
            continue;
          }
          const desiredState = local.desiredState ?? local.state;
          if (desiredState === "unknown" || remote.state === "unknown") {
            requires.push(requiresAction(local.scheduleId, remote, "external-ui-drift"));
            continue;
          }
          if (desiredState !== remote.state && desiredState !== "completed") {
            try {
              const next =
                desiredState === "paused"
                  ? safeRecord(
                      await this.driver.pause({
                        scheduleId: remote.scheduleId,
                        revisionHash: remote.revisionHash,
                        signal,
                      }),
                    )
                  : desiredState === "active"
                    ? safeRecord(
                        await this.driver.resume({
                          scheduleId: remote.scheduleId,
                          revisionHash: remote.revisionHash,
                          signal,
                        }),
                      )
                    : safeRecord(
                        await this.driver.delete({
                          scheduleId: remote.scheduleId,
                          revisionHash: remote.revisionHash,
                          signal,
                        }),
                      );
              if (next.state !== desiredState) {
                requires.push(
                  requiresAction(local.scheduleId, next, "reconciliation-not-verified"),
                );
                continue;
              }
              await this.store.save({ ...next, desiredState });
              output.push(next);
            } catch (error) {
              const result = failure(error, local.scheduleId);
              if (result.state === "unsupported")
                return {
                  state: "unsupported",
                  schedules: output,
                  conflicts,
                  requiresAction: [
                    ...requires,
                    requiresAction(local.scheduleId, remote, "unsupported"),
                  ],
                  provenance: output.flatMap((record) => record.provenance).slice(0, 16),
                };
              requires.push(requiresAction(local.scheduleId, remote, "external-ui-dialog"));
            }
          } else {
            output.push(remote);
            await this.store.save({ ...remote, desiredState });
          }
        }
        const state = conflicts.length || requires.length ? "requires_action" : "ok";
        return {
          state,
          schedules: output,
          conflicts,
          requiresAction: requires,
          provenance: output.flatMap((record) => record.provenance).slice(0, 16),
        } satisfies ChatgptScheduleReconcileResult;
      } catch (error) {
        const result = failure(error);
        return {
          state: result.state,
          schedules: [],
          conflicts: [],
          requiresAction: [requiresAction(undefined, undefined, result.reason)],
          provenance: [],
        } satisfies ChatgptScheduleReconcileResult;
      }
    });
  }
}

export async function listChatgptSchedules(
  driver: ChatgptScheduleDriver,
  signal?: AbortSignal,
): Promise<ChatgptScheduleOperationResult> {
  return new ChatgptScheduleService(driver).list(signal);
}
export async function getChatgptSchedule(
  driver: ChatgptScheduleDriver,
  scheduleId: string,
  signal?: AbortSignal,
): Promise<ChatgptScheduleOperationResult> {
  return new ChatgptScheduleService(driver).get(scheduleId, signal);
}
export async function createChatgptSchedule(
  driver: ChatgptScheduleDriver,
  input: ChatgptScheduleCreateInput,
  options?: ChatgptScheduleServiceOptions,
): Promise<ChatgptScheduleOperationResult> {
  return new ChatgptScheduleService(driver, undefined, options).create(input);
}
export async function updateChatgptSchedule(
  driver: ChatgptScheduleDriver,
  input: ChatgptScheduleUpdateInput,
  options?: ChatgptScheduleServiceOptions,
): Promise<ChatgptScheduleOperationResult> {
  return new ChatgptScheduleService(driver, undefined, options).update(input);
}
export async function pauseChatgptSchedule(
  driver: ChatgptScheduleDriver,
  input: ChatgptScheduleMutationInput,
  options?: ChatgptScheduleServiceOptions,
): Promise<ChatgptScheduleOperationResult> {
  return new ChatgptScheduleService(driver, undefined, options).pause(input);
}
export async function resumeChatgptSchedule(
  driver: ChatgptScheduleDriver,
  input: ChatgptScheduleMutationInput,
  options?: ChatgptScheduleServiceOptions,
): Promise<ChatgptScheduleOperationResult> {
  return new ChatgptScheduleService(driver, undefined, options).resume(input);
}
export async function deleteChatgptSchedule(
  driver: ChatgptScheduleDriver,
  input: ChatgptScheduleMutationInput,
  options?: ChatgptScheduleServiceOptions,
): Promise<ChatgptScheduleOperationResult> {
  return new ChatgptScheduleService(driver, undefined, options).delete(input);
}
export async function reconcileChatgptSchedules(
  driver: ChatgptScheduleDriver,
  store: ChatgptScheduleStore,
  signal?: AbortSignal,
  options?: ChatgptScheduleServiceOptions,
): Promise<ChatgptScheduleReconcileResult> {
  return new ChatgptScheduleService(driver, store, options).reconcile(signal);
}

export const chatgptScheduleApprovalChallengeForTest = challenge;
export const sanitizeChatgptScheduleRecordForTest = safeRecord;
