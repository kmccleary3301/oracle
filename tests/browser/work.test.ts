import { ApprovalGrantAuthority } from "../../src/browser/approvalToken.js";
import { describe, expect, test, vi } from "vitest";
import {
  classifyWorkSnapshot,
  createWorkApprovalChallenge,
} from "../../src/browser/actions/work.js";
import { ChatgptWorkService, type WorkBrowserDriver } from "../../src/browser/chatgpt/work.js";

describe("Work snapshot and approval capability", () => {
  test("classifies selected Work and exact saved conversation identity", () => {
    const snapshot = classifyWorkSnapshot(
      {
        url: "https://chatgpt.com/c/work-123",
        controls: { chat: true, work: true, workSelected: true },
        mode: "work",
        state: "running",
      },
      "work-123",
    );
    expect(snapshot).toMatchObject({ mode: "work", conversationId: "work-123", state: "running" });
    expect(
      classifyWorkSnapshot(
        { url: "https://chatgpt.com/c/other", mode: "work", workSelected: true },
        "work-123",
      ).state,
    ).toBe("conflict");
  });

  test("never turns missing or unknown controls into Chat", () => {
    expect(classifyWorkSnapshot({ url: "https://chatgpt.com/", controls: {} }).state).toBe(
      "unsupported",
    );
    expect(
      classifyWorkSnapshot({ url: "https://chatgpt.com/", mode: "chat", chatSelected: true }).state,
    ).toBe("conflict");
  });

  test("approval challenges are exact and one-time", () => {
    const challenge = createWorkApprovalChallenge("work-123", "rev-a");
    const authority = new ApprovalGrantAuthority({ dbPath: ":memory:" });
    const issued = authority.issueGrant(challenge, { localOperator: true });
    expect(issued.state).toBe("issued");
    if (issued.state !== "issued") return;
    expect(authority.consumeGrant(issued.grant, challenge).state).toBe("consumed");
    expect(authority.consumeGrant(issued.grant, challenge).state).toBe("requires_action");
  });
});

describe("ChatgptWorkService", () => {
  const snapshot = (overrides: Record<string, unknown> = {}) => ({
    url: "https://chatgpt.com/c/work-123",
    conversationId: "work-123",
    mode: "work" as const,
    controls: { chat: true, work: true, workSelected: true },
    state: "running" as const,
    turn: { id: "turn-1", active: true },
    plan: null,
    userQuestion: null,
    ...overrides,
  });

  test("does not mutate composer when Work is unsupported", async () => {
    const submitPrompt = vi.fn();
    const driver: WorkBrowserDriver = {
      ensureWorkMode: vi.fn().mockResolvedValue("unsupported"),
      readSnapshot: vi.fn(),
      submitPrompt,
      approvePlan: vi.fn(),
      interruptTurn: vi.fn(),
    };
    const service = new ChatgptWorkService(driver);
    await expect(service.start({ prompt: "private prompt" })).resolves.toMatchObject({
      state: "unsupported",
      accepted: false,
    });
    expect(submitPrompt).not.toHaveBeenCalled();
  });
  test("adopts the observed conversation identity when start has no conversation id", async () => {
    const before = snapshot({ conversationId: "current", url: "https://chatgpt.com/c/current" });
    const after = snapshot({
      conversationId: "new-conversation",
      url: "https://chatgpt.com/c/new-conversation",
      taskId: "task-7",
      turn: { id: "turn-7", active: true, revisionHash: "rev-7" },
      revisionHash: "rev-7",
      deliverables: [{ id: "artifact-7" }],
      provenance: [{ source: "chatgpt-dom", capturedAt: "2026-01-01T00:00:00.000Z" }],
    });
    const driver: WorkBrowserDriver = {
      ensureWorkMode: vi.fn().mockResolvedValue("work"),
      readSnapshot: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
      submitPrompt: vi.fn().mockResolvedValue({ accepted: true }),
      approvePlan: vi.fn(),
      interruptTurn: vi.fn(),
    };
    const result = await new ChatgptWorkService(driver).start({ prompt: "start work" });
    expect(result).toMatchObject({
      accepted: true,
      conversationId: "new-conversation",
      taskId: "task-7",
      turnId: "turn-7",
      revisionHash: "rev-7",
      deliverables: [{ id: "artifact-7" }],
    });
    expect(driver.readSnapshot).toHaveBeenNthCalledWith(1, undefined, undefined);
    expect(driver.readSnapshot).toHaveBeenNthCalledWith(2, undefined, undefined);
  });

  test("reports supplied conversation drift as a conflict", async () => {
    const driver: WorkBrowserDriver = {
      ensureWorkMode: vi.fn().mockResolvedValue("work"),
      readSnapshot: vi
        .fn()
        .mockResolvedValueOnce(snapshot({ conversationId: "expected" }))
        .mockResolvedValueOnce(
          snapshot({ conversationId: "drifted", url: "https://chatgpt.com/c/drifted" }),
        ),
      submitPrompt: vi.fn().mockResolvedValue({ accepted: true }),
      approvePlan: vi.fn(),
      interruptTurn: vi.fn(),
    };
    await expect(
      new ChatgptWorkService(driver).start({ prompt: "start work", conversationId: "expected" }),
    ).resolves.toMatchObject({
      state: "conflict",
      accepted: false,
      reason: "conversation-mismatch",
    });
    expect(driver.submitPrompt).toHaveBeenCalledTimes(1);
  });

  test("answers only the matched active user question", async () => {
    const driver: WorkBrowserDriver = {
      ensureWorkMode: vi.fn(),
      readSnapshot: vi
        .fn()
        .mockResolvedValueOnce(snapshot({ state: "waiting_for_user_input" }))
        .mockResolvedValueOnce(snapshot({ state: "running" })),
      submitPrompt: vi.fn().mockResolvedValue({ accepted: true }),
      approvePlan: vi.fn(),
      interruptTurn: vi.fn(),
    };
    const service = new ChatgptWorkService(driver);
    await expect(
      service.answer({ conversationId: "work-123", turnId: "other", answer: "answer" }),
    ).resolves.toMatchObject({ state: "conflict" });
    expect(driver.submitPrompt).not.toHaveBeenCalled();
  });

  test("dry-runs safe approval and refuses a consequential plan", async () => {
    const driver: WorkBrowserDriver = {
      ensureWorkMode: vi.fn(),
      readSnapshot: vi
        .fn()
        .mockResolvedValueOnce(
          snapshot({
            state: "waiting_for_plan_approval",
            plan: { revisionHash: "rev-a", consequential: false },
          }),
        )
        .mockResolvedValueOnce(
          snapshot({
            state: "waiting_for_plan_approval",
            plan: { revisionHash: "rev-a", consequential: true },
          }),
        ),
      submitPrompt: vi.fn(),
      approvePlan: vi.fn(),
      interruptTurn: vi.fn(),
    };
    const service = new ChatgptWorkService(driver);
    await expect(
      service.approve({ conversationId: "work-123", dryRun: true }),
    ).resolves.toMatchObject({ state: "waiting_for_plan_approval", dryRun: true });
    await expect(
      service.approve({ conversationId: "work-123", approvalGrant: "x" }),
    ).resolves.toMatchObject({ state: "requires_action" });
    expect(driver.approvePlan).not.toHaveBeenCalled();
  });

  test("interrupts only matched active turn and verifies driver result", async () => {
    const driver: WorkBrowserDriver = {
      ensureWorkMode: vi.fn(),
      readSnapshot: vi.fn().mockResolvedValue(snapshot()),
      submitPrompt: vi.fn(),
      approvePlan: vi.fn(),
      interruptTurn: vi.fn().mockResolvedValue({ state: "interrupted", verified: true }),
    };
    const service = new ChatgptWorkService(driver);
    await expect(
      service.interrupt({ conversationId: "work-123", turnId: "turn-1" }),
    ).resolves.toMatchObject({ state: "interrupted", verified: true });
    expect(driver.interruptTurn).toHaveBeenCalledWith({
      conversationId: "work-123",
      turnId: "turn-1",
    });
  });
});
