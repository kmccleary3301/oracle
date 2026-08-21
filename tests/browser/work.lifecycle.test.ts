import { ApprovalGrantAuthority } from "../../src/browser/approvalToken.js";
import { describe, expect, test, vi, type MockedFunction } from "vitest";
import {
  classifyWorkSnapshot,
  createWorkApprovalChallenge,
  type WorkSnapshot,
} from "../../src/browser/actions/work.js";
import {
  ChatgptWorkService,
  classifyWorkError,
  type WorkBrowserDriver,
} from "../../src/browser/chatgpt/work.js";

const conversationId = "conversation-work-1";
const taskId = "task-work-1";
const turnId = "turn-work-1";
const questionId = "question-work-1";
const revisionHash = "revision-work-1";
const provenance = {
  source: "chatgpt-dom" as const,
  capturedAt: "2026-08-10T12:00:00.000Z",
  conversationUrl: `https://chatgpt.com/c/${conversationId}`,
  conversationId,
  turnId,
};

function snapshot(overrides: Partial<WorkSnapshot> = {}): WorkSnapshot {
  return {
    url: `https://chatgpt.com/c/${conversationId}`,
    conversationId,
    mode: "work",
    controls: { chat: true, work: true, workSelected: true },
    state: "running",
    turn: { id: turnId, revisionHash, active: true },
    plan: null,
    userQuestion: null,
    taskId,
    revisionHash,
    deliverables: [],
    provenance: [provenance],
    ...overrides,
  };
}

type SnapshotReaderMock = MockedFunction<WorkBrowserDriver["readSnapshot"]>;
type FixtureDriver = WorkBrowserDriver & { readSnapshot: SnapshotReaderMock };

function driverWithSnapshots(states: WorkSnapshot[]): FixtureDriver {
  return {
    ensureWorkMode: vi.fn().mockResolvedValue("work"),
    readSnapshot: vi
      .fn<WorkBrowserDriver["readSnapshot"]>()
      .mockImplementation(async () => states.shift() ?? snapshot()),
    submitPrompt: vi.fn().mockResolvedValue({
      accepted: true,
      conversationUrl: `https://chatgpt.com/c/${conversationId}`,
    }),
    approvePlan: vi.fn(),
    interruptTurn: vi.fn(),
  };
}

describe("ChatGPT Work deterministic lifecycle fixtures", () => {
  test("keeps waiting states observable and preserves exact identity through completion", async () => {
    const safePlan = {
      revisionHash: "revision-approval-1",
      action: "collect the requested files",
      summary: "Read-only collection",
      consequential: false,
      externalWrite: false,
      unknown: false,
      approvePoint: { x: 11, y: 12 },
    };
    const first = snapshot({ state: "running", revisionHash, deliverables: [] });
    const afterStart = snapshot({ state: "running", revisionHash, deliverables: [] });
    const waitingForUser = snapshot({
      state: "waiting_for_user_input",
      userQuestion: { id: questionId, question: "Which directory?", answerPoint: { x: 13, y: 14 } },
    });
    const afterAnswer = snapshot({ state: "running", deliverables: [] });
    const waitingForApproval = snapshot({
      state: "waiting_for_plan_approval",
      revisionHash: safePlan.revisionHash,
      plan: safePlan,
    });
    const afterApproval = snapshot({
      state: "running",
      revisionHash: safePlan.revisionHash,
      deliverables: [],
    });
    const completed = snapshot({
      state: "completed",
      turn: { id: turnId, revisionHash: safePlan.revisionHash, active: false },
      revisionHash: safePlan.revisionHash,
      deliverables: [
        {
          id: "deliverable-1",
          name: "summary.md",
          size: 17,
          mimeType: "text/markdown",
          sha256: "hash-summary",
          taskId,
          conversationId,
          turnId,
          revisionHash: safePlan.revisionHash,
          provenance,
        },
        {
          id: "deliverable-2",
          name: "evidence.json",
          size: 23,
          mimeType: "application/json",
          sha256: "hash-evidence",
          taskId,
          conversationId,
          turnId,
          revisionHash: safePlan.revisionHash,
          provenance,
        },
      ],
    });

    const driver = driverWithSnapshots([first, afterStart, waitingForUser, afterAnswer]);
    const authority = new ApprovalGrantAuthority({ dbPath: ":memory:" });
    const service = new ChatgptWorkService(driver, undefined, authority);
    await expect(
      service.start({ prompt: "Run the work task", conversationId }),
    ).resolves.toMatchObject({
      state: "running",
      conversationId,
      taskId,
      revisionHash,
      provenance: [provenance],
    });

    driver.readSnapshot
      .mockImplementationOnce(async () => waitingForUser)
      .mockImplementationOnce(async () => afterAnswer);
    await expect(
      service.answer({
        conversationId,
        questionId,
        turnId,
        expectedRevisionHash: revisionHash,
        answer: "Use /tmp/input",
      }),
    ).resolves.toMatchObject({
      state: "running",
      conversationId,
      taskId,
      turnId,
      revisionHash,
      provenance: [provenance],
    });
    const dry = await service.approve({
      conversationId,
      expectedRevisionHash: revisionHash,
      dryRun: true,
    });
    expect(dry).toMatchObject({
      state: "waiting_for_plan_approval",
      dryRun: true,
      taskId,
      revisionHash,
      provenance: [provenance],
    });
    if (!dry.approvalChallenge) return;
    const issued = authority.issueGrant(dry.approvalChallenge, { localOperator: true });
    expect(issued.state).toBe("issued");
    if (issued.state !== "issued") return;
    driver.approvePlan = vi.fn().mockResolvedValue({
      state: "running",
      dryRun: false,
      approvalChallenge: dry.approvalChallenge,
      plan: safePlan,
      taskId,
      conversationId,
      revisionHash: safePlan.revisionHash,
      provenance: [provenance],
    });
    driver.readSnapshot
      .mockImplementationOnce(async () => waitingForApproval)
      .mockImplementationOnce(async () => afterApproval);
    await expect(
      service.approve({
        conversationId,
        expectedRevisionHash: revisionHash,
        approvalChallenge: dry.approvalChallenge,
        approvalGrant: issued.grant,
      }),
    ).resolves.toMatchObject({
      state: "running",
      taskId,
      revisionHash: safePlan.revisionHash,
      provenance: [provenance],
    });

    driver.readSnapshot.mockImplementationOnce(async () => completed);
    await expect(service.status({ conversationId })).resolves.toMatchObject({
      state: "completed",
      conversationId,
      taskId,
      revisionHash: safePlan.revisionHash,
      deliverables: completed.deliverables,
      provenance: [provenance],
    });
    expect(completed.deliverables).toHaveLength(2);
    expect(
      completed.deliverables?.map((item) => [
        item.id,
        item.size,
        item.mimeType,
        item.sha256,
        item.provenance,
      ]),
    ).toEqual([
      ["deliverable-1", 17, "text/markdown", "hash-summary", provenance],
      ["deliverable-2", 23, "application/json", "hash-evidence", provenance],
    ]);
  });

  test("answers only the exact question and revision, never a stale task", async () => {
    const staleQuestion = snapshot({
      state: "waiting_for_user_input",
      taskId: "task-old",
      userQuestion: { id: "question-old", question: "Old question" },
      revisionHash: "revision-old",
    });
    const driver = driverWithSnapshots([staleQuestion]);
    const service = new ChatgptWorkService(driver);

    await expect(
      service.answer({
        conversationId,
        taskId,
        questionId,
        turnId,
        expectedRevisionHash: revisionHash,
        answer: "answer",
      }),
    ).resolves.toMatchObject({
      state: "conflict",
      accepted: false,
      reason: "task-question-revision-mismatch",
      conversationId,
      taskId: "task-old",
      turnId,
      revisionHash: "revision-old",
    });
    expect(driver.submitPrompt).not.toHaveBeenCalled();
  });

  test("requires the exact approval challenge and revision before approving", async () => {
    const plan = {
      revisionHash,
      consequential: false,
      externalWrite: false,
      unknown: false,
      approvePoint: { x: 1, y: 2 },
    };
    const stale = snapshot({
      state: "waiting_for_plan_approval",
      plan,
      revisionHash: "revision-new",
    });
    const driver = driverWithSnapshots([stale]);
    const service = new ChatgptWorkService(driver);

    await expect(
      service.approve({
        conversationId,
        expectedRevisionHash: "revision-work-1",
        approvalChallenge: createWorkApprovalChallenge(conversationId, "revision-old"),
        approvalGrant: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    ).resolves.toMatchObject({
      state: "conflict",
      reason: "revision-mismatch",
      taskId,
      revisionHash: "revision-new",
    });
    expect(driver.approvePlan).not.toHaveBeenCalled();
  });

  test("pause is observable and resume is reported only after an observed transition", async () => {
    const paused = snapshot({
      state: "running",
      lifecycle: "paused",
      paused: true,
      turn: { id: turnId, revisionHash, active: false },
    });
    const working = snapshot({
      state: "running",
      lifecycle: "working",
      paused: false,
      turn: { id: turnId, revisionHash, active: true },
    });
    const driver = driverWithSnapshots([snapshot(), paused, paused, working]);
    driver.pauseTurn = vi
      .fn()
      .mockResolvedValue({ state: "running", lifecycle: "paused", verified: true });
    driver.resumeTurn = vi
      .fn()
      .mockResolvedValue({ state: "running", lifecycle: "working", verified: true });
    const service = new ChatgptWorkService(driver);

    await expect(service.pause({ conversationId, taskId, turnId })).resolves.toMatchObject({
      state: "running",
      lifecycle: "paused",
      verified: true,
    });
    await expect(service.resume({ conversationId, taskId, turnId })).resolves.toMatchObject({
      state: "running",
      lifecycle: "working",
      verified: true,
    });
    expect(driver.pauseTurn).toHaveBeenCalledWith({ conversationId, taskId, turnId });
    expect(driver.resumeTurn).toHaveBeenCalledWith({ conversationId, taskId, turnId });
  });

  test("targeted interrupt and unknown external dialog fail closed", async () => {
    const driver = driverWithSnapshots([snapshot()]);
    driver.interruptTurn = vi.fn().mockResolvedValue({ state: "interrupted", verified: true });
    const service = new ChatgptWorkService(driver);
    await expect(service.interrupt({ conversationId, taskId, turnId })).resolves.toMatchObject({
      state: "interrupted",
      verified: true,
    });
    expect(driver.interruptTurn).toHaveBeenCalledWith({ conversationId, turnId, taskId });

    expect(
      classifyWorkSnapshot(
        {
          url: `https://chatgpt.com/c/${conversationId}`,
          mode: "work",
          controls: { work: true, workSelected: true },
          state: "running",
          taskId,
          turn: { id: turnId, revisionHash, active: true },
          dialog: { kind: "external", unknown: true },
        },
        conversationId,
      ),
    ).toMatchObject({
      state: "requires_action",
      conversationId,
      taskId,
      turn: { id: turnId },
      reason: "unknown-external-dialog",
    });
  });

  test.each([
    ["partial", "partial output", false],
    ["error", "work failed", false],
    ["rate-limited", "429 rate limit; retry after 2s", true],
    ["disconnected", "websocket disconnected", true],
    ["recovery", "connection lost; recover the same task", true],
  ] as const)("classifies %s as a recoverable/non-terminal outcome", (code, message, retryable) => {
    expect(classifyWorkError(new Error(message))).toMatchObject({ code, retryable });
  });
});
