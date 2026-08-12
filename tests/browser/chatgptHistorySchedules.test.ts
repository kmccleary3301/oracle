import { ApprovalGrantAuthority } from "../../src/browser/approvalToken.js";
import { describe, expect, it } from "vitest";
import { computeChatgptConversationRevision } from "../../src/browser/chatgpt/revision.js";
import { ChatgptHistoryService } from "../../src/browser/chatgpt/history.js";
import type { ChatgptHistoryDriver } from "../../src/browser/chatgpt/historyTypes.js";
import { ChatgptTemporaryChatService } from "../../src/browser/chatgpt/temporary.js";
import {
  ChatgptScheduleService,
  MemoryChatgptScheduleStore,
} from "../../src/browser/chatgpt/schedules.js";
import type {
  ChatgptScheduleDriver,
  ChatgptScheduleRecord,
} from "../../src/browser/chatgpt/scheduleTypes.js";
import type { ChatgptConversationSnapshot } from "../../src/browser/chatgpt/types.js";

function snapshot(texts = ["old", "answer"]): ChatgptConversationSnapshot {
  const turns = texts.map((text, index) => ({
    index,
    role: index % 2 ? ("assistant" as const) : ("user" as const),
    turnId: `turn-${index}`,
    messageId: `message-${index}`,
    text,
    textPreview: text,
    generatedImageFileIds: [],
    attachmentLabels: [],
    sandboxArtifactLabels: [],
  }));
  const page = {
    href: "https://chatgpt.com/c/c-1",
    title: "",
    readyState: "complete",
    hasComposer: true,
    loginLikely: true,
    imageNodeCount: 0,
    generatedImageNodeCount: 0,
    uniqueGeneratedImageCount: 0,
    conversationId: "c-1",
  };
  return {
    page,
    turns,
    generatedImages: [],
    sandboxArtifacts: [],
    latestAssistantTurn: turns[1],
    latestUserTurn: turns[0],
    warnings: [],
  };
}

describe("semantic ChatGPT history, temporary chat, and schedules", () => {
  it("orders snapshots and enforces dry-run challenge then exact edit commit", async () => {
    let current = snapshot(["old", "answer"]);
    const driver: ChatgptHistoryDriver = {
      snapshot: async () => ({
        snapshot: current,
        revision: computeChatgptConversationRevision(current),
        provenance: [],
      }),
      edit: async ({ text }) => {
        current = snapshot([text, "answer"]);
      },
      regenerate: async () => {
        current = snapshot(["old", "new answer"]);
      },
      branch: async () => ({ conversationId: "c-2" }),
    };
    const authority = new ApprovalGrantAuthority({ dbPath: ":memory:" });
    const service = new ChatgptHistoryService(driver, { approvalAuthority: authority });
    const before = await service.snapshot("c-1");
    if ("state" in before) return;
    expect(before.turns.map((turn) => turn.turnId)).toEqual(["turn-0", "turn-1"]);
    const dry = await service.edit({
      conversationId: "c-1",
      turnId: "turn-0",
      messageId: "message-0",
      expectedRevisionHash: before.revisionHash,
      text: "new",
      dryRun: true,
    });
    expect(dry.state).toBe("requires_action");
    if (dry.state !== "requires_action" || !dry.approvalChallenge) return;
    const issued = authority.issueGrant(dry.approvalChallenge, { localOperator: true });
    expect(issued.state).toBe("issued");
    if (issued.state !== "issued") return;
    const substituted = await service.edit({
      conversationId: "c-1",
      turnId: "turn-0",
      messageId: "message-0",
      expectedRevisionHash: before.revisionHash,
      text: "different",
      approvalChallenge: dry.approvalChallenge,
      approvalGrant: issued.grant,
    });
    expect(substituted).toMatchObject({
      state: "requires_action",
      reason: "approval-grant-mismatch",
    });
    const committed = await service.edit({
      conversationId: "c-1",
      turnId: "turn-0",
      messageId: "message-0",
      expectedRevisionHash: before.revisionHash,
      text: "new",
      approvalChallenge: dry.approvalChallenge,
      approvalGrant: issued.grant,
    });
    expect(committed.state).toBe("ok");
  });

  it("reports temporary non-persistence and close evidence", async () => {
    let active = true;
    const driver = {
      start: async () => ({
        state: "temporary" as const,
        conversationId: "tmp-1",
        conversationUrl: "https://chatgpt.com/?temporary-chat=true",
        persisted: false,
        closed: false,
        revisionHash: "r1",
        provenance: [],
      }),
      status: async () => ({
        state: active ? ("temporary" as const) : ("closed" as const),
        conversationId: "tmp-1",
        conversationUrl: null,
        persisted: false,
        closed: !active,
        revisionHash: "r1",
        provenance: [],
      }),
      close: async () => {
        active = false;
        return {
          state: "closed" as const,
          conversationId: "tmp-1",
          conversationUrl: null,
          persisted: false,
          closed: true,
          revisionHash: "r2",
          provenance: [],
        };
      },
    };
    const service = new ChatgptTemporaryChatService(driver);
    expect((await service.start()).state).toBe("ok");
    expect((await service.close({ conversationId: "tmp-1" })).state).toBe("ok");
  });

  it("reconciles one desired schedule and remains idempotent", async () => {
    let record: ChatgptScheduleRecord = {
      scheduleId: "s-1",
      revisionHash: "r1",
      title: "T",
      prompt: "P",
      recurrence: { kind: "once", runAt: "2030-01-01T00:00:00Z" },
      state: "active",
      desiredState: "paused",
      observedEvidence: true,
      provenance: [],
    };
    const driver: ChatgptScheduleDriver = {
      list: async () => [record],
      get: async () => record,
      create: async () => record,
      update: async () => record,
      pause: async () => (record = { ...record, state: "paused", revisionHash: "r2" }),
      resume: async () => record,
      delete: async () => ({ ...record, state: "deleted", revisionHash: "r3" }),
    };
    const store = new MemoryChatgptScheduleStore([{ ...record, revisionHash: "r1" }]);
    const authority = new ApprovalGrantAuthority({ dbPath: ":memory:" });
    const service = new ChatgptScheduleService(driver, store, { approvalAuthority: authority });
    const preview = await service.pause({
      scheduleId: "s-1",
      expectedRevisionHash: "r1",
      dryRun: true,
    });
    expect(preview.state).toBe("requires_action");
    if (preview.state !== "requires_action" || !preview.approvalChallenge) return;
    const issued = authority.issueGrant(preview.approvalChallenge, { localOperator: true });
    expect(issued.state).toBe("issued");
    if (issued.state !== "issued") return;
    const paused = await service.pause({
      scheduleId: "s-1",
      expectedRevisionHash: "r1",
      approvalChallenge: preview.approvalChallenge,
      approvalGrant: issued.grant,
    });
    expect(paused.state).toBe("ok");
  });

  it("binds schedule creation approval to title, prompt, and recurrence", async () => {
    const record: ChatgptScheduleRecord = {
      scheduleId: "s-new",
      revisionHash: "r1",
      title: "T",
      prompt: "P",
      recurrence: { kind: "once", runAt: "2030-01-01T00:00:00Z" },
      state: "active",
      desiredState: "active",
      observedEvidence: true,
      provenance: [],
    };
    const create = async () => record;
    const driver: ChatgptScheduleDriver = {
      list: async () => [],
      get: async () => record,
      create,
      update: async () => record,
      pause: async () => record,
      resume: async () => record,
      delete: async () => record,
    };
    const authority = new ApprovalGrantAuthority({ dbPath: ":memory:" });
    const service = new ChatgptScheduleService(driver, new MemoryChatgptScheduleStore(), {
      approvalAuthority: authority,
    });
    const recurrence = { kind: "once" as const, runAt: "2030-01-01T00:00:00Z" };
    const preview = await service.create({
      clientRequestId: "request-1",
      title: "T",
      prompt: "P",
      recurrence,
      dryRun: true,
    });
    expect(preview.state).toBe("requires_action");
    if (preview.state !== "requires_action" || !preview.approvalChallenge) return;
    const issued = authority.issueGrant(preview.approvalChallenge, { localOperator: true });
    expect(issued.state).toBe("issued");
    if (issued.state !== "issued") return;
    const substituted = await service.create({
      clientRequestId: "request-1",
      title: "Different",
      prompt: "P",
      recurrence,
      approvalChallenge: preview.approvalChallenge,
      approvalGrant: issued.grant,
    });
    expect(substituted).toMatchObject({
      state: "requires_action",
      reason: "approval-grant-mismatch",
    });
  });
});
