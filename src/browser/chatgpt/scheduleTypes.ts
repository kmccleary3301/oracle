import type { ApprovalChallenge, ApprovalGrantAuthority } from "../approvalToken.js";
import type { BrowserResponseProvenance } from "../types.js";
import type { ChatgptCapabilityEvidence } from "./historyTypes.js";

export type ChatgptScheduleState = "active" | "paused" | "completed" | "deleted" | "unknown";
export type ChatgptScheduleRecurrence =
  | { kind: "once"; runAt: string }
  | { kind: "daily"; hour: number; minute: number; timezone?: string }
  | { kind: "weekly"; days: number[]; hour: number; minute: number; timezone?: string }
  | { kind: "interval"; everyMinutes: number; timezone?: string };

export interface ChatgptScheduleRecord {
  scheduleId: string;
  revisionHash: string;
  title: string;
  prompt: string;
  recurrence: ChatgptScheduleRecurrence;
  state: ChatgptScheduleState;
  desiredState?: Exclude<ChatgptScheduleState, "unknown">;
  nextRunAt?: string | null;
  lastObservedRunAt?: string | null;
  observedEvidence: boolean;
  capability?: ChatgptCapabilityEvidence;
  provenance: BrowserResponseProvenance[];
}

export type ChatgptScheduleOperation =
  | "chatgpt.schedule.create"
  | "chatgpt.schedule.update"
  | "chatgpt.schedule.pause"
  | "chatgpt.schedule.resume"
  | "chatgpt.schedule.delete";

export interface ChatgptScheduleMutationInput {
  scheduleId: string;
  expectedRevisionHash: string;
  dryRun?: boolean;
  approvalChallenge?: ApprovalChallenge;
  approvalGrant?: string;
  signal?: AbortSignal;
}

export interface ChatgptScheduleCreateInput {
  scheduleId?: string;
  clientRequestId?: string;
  expectedRevisionHash?: string;
  title: string;
  prompt: string;
  recurrence: ChatgptScheduleRecurrence;
  dryRun?: boolean;
  approvalChallenge?: ApprovalChallenge;
  approvalGrant?: string;
  signal?: AbortSignal;
}

export interface ChatgptScheduleUpdateInput extends ChatgptScheduleMutationInput {
  title?: string;
  prompt?: string;
  recurrence?: ChatgptScheduleRecurrence;
}

export interface ChatgptScheduleServiceOptions {
  approvalAuthority?: ApprovalGrantAuthority;
  principal?: string;
  session?: string;
}

export interface ChatgptScheduleMutationResult {
  state: "ok";
  operation: ChatgptScheduleOperation;
  schedule: ChatgptScheduleRecord;
  revisionHash: string;
  changed: boolean;
  provenance: BrowserResponseProvenance[];
  capability?: ChatgptCapabilityEvidence;
}

export interface ChatgptScheduleListResult {
  state: "ok";
  schedules: ChatgptScheduleRecord[];
  provenance: BrowserResponseProvenance[];
}

export interface ChatgptScheduleGetResult {
  state: "ok";
  schedule: ChatgptScheduleRecord;
  revisionHash: string;
  provenance: BrowserResponseProvenance[];
}

export interface ChatgptScheduleConflict {
  state: "conflict";
  scheduleId: string;
  expectedRevisionHash?: string;
  observedRevisionHash?: string;
  reason: "revision-conflict" | "external-drift" | "identity-conflict";
  schedule?: ChatgptScheduleRecord;
  provenance: BrowserResponseProvenance[];
}

export interface ChatgptScheduleRequiresAction {
  state: "requires_action";
  scheduleId?: string;
  revisionHash?: string;
  approvalChallenge?: ApprovalChallenge;
  reason: string;
  schedule?: ChatgptScheduleRecord;
  provenance: BrowserResponseProvenance[];
}

export interface ChatgptScheduleFailure {
  state: "requires_action" | "unsupported";
  scheduleId?: string;
  approvalChallenge?: ApprovalChallenge;
  reason: string;
  provenance: BrowserResponseProvenance[];
}

export type ChatgptScheduleOperationResult =
  | ChatgptScheduleMutationResult
  | ChatgptScheduleListResult
  | ChatgptScheduleGetResult
  | ChatgptScheduleConflict
  | ChatgptScheduleRequiresAction
  | ChatgptScheduleFailure;

export interface ChatgptScheduleDriver {
  list(input?: { signal?: AbortSignal }): Promise<ChatgptScheduleRecord[]>;
  get(input: { scheduleId: string; signal?: AbortSignal }): Promise<ChatgptScheduleRecord>;
  create(input: {
    scheduleId?: string;
    clientRequestId?: string;
    title: string;
    prompt: string;
    recurrence: ChatgptScheduleRecurrence;
    revisionHash: string;
    signal?: AbortSignal;
  }): Promise<ChatgptScheduleRecord>;
  update(input: {
    scheduleId: string;
    title?: string;
    prompt?: string;
    recurrence?: ChatgptScheduleRecurrence;
    revisionHash: string;
    signal?: AbortSignal;
  }): Promise<ChatgptScheduleRecord>;
  pause(input: {
    scheduleId: string;
    revisionHash: string;
    signal?: AbortSignal;
  }): Promise<ChatgptScheduleRecord>;
  resume(input: {
    scheduleId: string;
    revisionHash: string;
    signal?: AbortSignal;
  }): Promise<ChatgptScheduleRecord>;
  delete(input: {
    scheduleId: string;
    revisionHash: string;
    signal?: AbortSignal;
  }): Promise<ChatgptScheduleRecord | void>;
}

export interface ChatgptScheduleStore {
  load(): Promise<ChatgptScheduleRecord[]> | ChatgptScheduleRecord[];
  save(record: ChatgptScheduleRecord): Promise<void> | void;
  remove(scheduleId: string): Promise<void> | void;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

export interface ChatgptScheduleReconcileResult {
  state: "ok" | "requires_action" | "unsupported";
  schedules: ChatgptScheduleRecord[];
  conflicts: ChatgptScheduleConflict[];
  requiresAction: ChatgptScheduleRequiresAction[];
  provenance: BrowserResponseProvenance[];
}
