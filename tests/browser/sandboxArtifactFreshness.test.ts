import { describe, expect, test } from "vitest";
import { anchorSandboxArtifactsToCurrentTurn } from "../../src/browser/index.ts";
import type { ChatgptSandboxArtifactRef } from "../../src/browser/chatgpt/types.js";

describe("sandbox artifact freshness anchoring", () => {
  const artifacts: ChatgptSandboxArtifactRef[] = [
    {
      label: "old patch",
      turnIndex: 32,
      turnId: "turn-32",
      messageId: "msg-old",
      documentIndex: 0,
    },
    {
      label: "current patch",
      turnIndex: 43,
      turnId: "turn-43",
      messageId: "msg-current",
      documentIndex: 1,
    },
  ];

  test("prefers captured assistant message id when available", () => {
    expect(
      anchorSandboxArtifactsToCurrentTurn(artifacts, {
        baselineTurns: 42,
        answerMessageId: "msg-current",
      }),
    ).toEqual([
      expect.objectContaining({
        label: "current patch",
        artifactFreshness: "messageId",
      }),
    ]);
  });

  test("falls back to turn index floor when message id is unavailable", () => {
    expect(
      anchorSandboxArtifactsToCurrentTurn(artifacts, {
        baselineTurns: 42,
      }),
    ).toEqual([
      expect.objectContaining({
        label: "current patch",
        artifactFreshness: "turnIndex",
      }),
    ]);
  });
});
