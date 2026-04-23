import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensurePromptReady: vi.fn(),
  submitPreparedPrompt: vi.fn(),
  submitPrompt: vi.fn(),
  waitForAssistantResponse: vi.fn(),
}));

vi.mock("../../src/browser/actions/navigation.js", () => ({
  ensurePromptReady: mocks.ensurePromptReady,
}));

vi.mock("../../src/browser/actions/promptComposer.js", () => ({
  submitPreparedPrompt: mocks.submitPreparedPrompt,
  submitPrompt: mocks.submitPrompt,
}));

vi.mock("../../src/browser/actions/assistantResponse.js", () => ({
  waitForAssistantResponse: mocks.waitForAssistantResponse,
}));

import { chatgptDomProvider } from "../../src/browser/providers/chatgptDomProvider.js";

interface TestProviderState extends Record<string, unknown> {
  runtime: Record<string, never>;
  input: Record<string, never>;
  logger: ReturnType<typeof vi.fn>;
  timeoutMs: number;
  baselineTurns?: number;
}

describe("chatgptDomProvider baseline tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets a conservative response baseline after prompt submission", async () => {
    mocks.submitPrompt.mockResolvedValue(2);

    const state: TestProviderState = {
      runtime: {},
      input: {},
      logger: vi.fn(),
      timeoutMs: 30_000,
    };

    await chatgptDomProvider.submitPrompt({
      prompt: "create one image",
      evaluate: vi.fn(),
      delay: vi.fn(),
      state,
    });

    expect(state.baselineTurns).toBe(0);
  });

  it("does not advance an existing caller baseline past the assistant response", async () => {
    mocks.submitPrompt.mockResolvedValue(8);
    mocks.waitForAssistantResponse.mockResolvedValue({
      text: "Edit",
      html: "<div>image</div>",
      meta: { turnId: "conversation-turn-8" },
    });

    const state: TestProviderState = {
      runtime: {},
      input: {},
      logger: vi.fn(),
      timeoutMs: 30_000,
      baselineTurns: 6,
    };

    await chatgptDomProvider.submitPrompt({
      prompt: "edit this image",
      evaluate: vi.fn(),
      delay: vi.fn(),
      state,
    });
    await chatgptDomProvider.waitForResponse({
      prompt: "edit this image",
      evaluate: vi.fn(),
      delay: vi.fn(),
      state,
    });

    expect(state.baselineTurns).toBe(6);
    expect(mocks.waitForAssistantResponse).toHaveBeenCalledWith(
      state.runtime,
      30_000,
      state.logger,
      6,
    );
  });
});
