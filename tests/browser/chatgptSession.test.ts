import { beforeEach, describe, expect, it, vi } from "vitest";

const { runBrowserMode } = vi.hoisted(() => ({
  runBrowserMode: vi.fn(),
}));

vi.mock("../../src/browser/index.js", () => ({
  runBrowserMode,
}));

import { createChatgptSession } from "../../src/browser/chatgpt/session.js";

describe("chatgpt session submission metadata", () => {
  beforeEach(() => {
    runBrowserMode.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T12:00:00.000Z"));
  });

  it("returns recovery guidance for submitted extended-thinking turns", async () => {
    runBrowserMode.mockResolvedValue({
      answerText: "",
      answerMarkdown: "",
      tookMs: 1234,
      answerTokens: 0,
      answerChars: 0,
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/test-conversation",
      thinkingTimeSelection: {
        requestedThinkingTime: "extended",
        actualThinkingTime: "Extended",
        status: "selected",
        fallbackUsed: false,
      },
      warnings: ["submitted"],
    });

    const result = await createChatgptSession({
      prompt: "test",
      returnAfterSubmit: true,
      config: {},
    });

    expect(result.status).toBe("submitted");
    expect(result.conversationUrl).toBe("https://chatgpt.com/c/test-conversation");
    expect(result.submittedAt).toBe("2026-05-10T12:00:00.000Z");
    expect(result.recommendedRecoveryDelayMs).toBe(20 * 60_000);
    expect(result.earliestRecoveryAt).toBe("2026-05-10T12:20:00.000Z");
    expect(result.monitoringGuidance).toContain("not a completed Pro answer");
    expect(result.answerText).toBe("");
  });
});
