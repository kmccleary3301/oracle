import { describe, expect, it } from "vitest";
import {
  computeChatgptConversationRevision,
  revisionsEqual,
  type ChatgptConversationRevisionObservation,
} from "../../src/browser/chatgpt/revision.js";

const conversationUrl = "https://chatgpt.com/c/conversation-1";

function observation(
  turns: ChatgptConversationRevisionObservation["turns"],
): ChatgptConversationRevisionObservation {
  return { conversationUrl, conversationId: "conversation-1", turns };
}

const turns = [
  { index: 0, role: "user" as const, turnId: "turn-u", messageId: "message-u", text: "hello" },
  {
    index: 1,
    role: "assistant" as const,
    turnId: "turn-a",
    messageId: "message-a",
    text: "world",
  },
];

describe("ChatGPT conversation revisions", () => {
  it("is deterministic and does not retain raw turn text", () => {
    const first = computeChatgptConversationRevision(observation(turns));
    const second = computeChatgptConversationRevision(observation(structuredClone(turns)));

    expect(first).toEqual(second);
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain("hello");
    expect(JSON.stringify(first)).not.toContain("world");
    expect(first.turns[0]?.textHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["text", [{ ...turns[0], text: "changed" }, turns[1]], "content"],
    ["turn identity", [{ ...turns[0], turnId: "other-turn" }, turns[1]], "identity"],
    ["message identity", [{ ...turns[0], messageId: "other-message" }, turns[1]], "identity"],
    ["order", [turns[1], turns[0]], "order"],
  ])("detects %s changes", (_kind, changedTurns, _reason) => {
    const baseline = computeChatgptConversationRevision(observation(turns));
    const changed = computeChatgptConversationRevision(observation(changedTurns));

    expect(revisionsEqual(baseline, changed)).toBe(false);
    expect(changed.hash).not.toBe(baseline.hash);
  });

  it("accepts an unchanged conversation head", () => {
    const baseline = computeChatgptConversationRevision(observation(turns));
    const observed = computeChatgptConversationRevision(observation(turns));

    expect(revisionsEqual(baseline, observed)).toBe(true);
  });

  it("includes conversation identity in the revision", () => {
    const baseline = computeChatgptConversationRevision(observation(turns));
    const otherConversation = computeChatgptConversationRevision(
      { ...observation(turns), conversationId: "conversation-2" },
      "https://chatgpt.com/c/conversation-2",
    );

    expect(revisionsEqual(baseline, otherConversation)).toBe(false);
  });
});
