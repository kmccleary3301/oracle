import { describe, expect, test, vi } from "vitest";
import { readAssistantSnapshot } from "../../src/browser/actions/assistantResponse.ts";
import type { ChromeClient } from "../../src/browser/types.js";

describe("assistant response freshness", () => {
  test("rejects unknown-turn snapshots when a freshness floor is supplied", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            text: "old fallback answer",
            html: "<p>old fallback answer</p>",
            messageId: null,
            turnId: null,
            turnIndex: null,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(readAssistantSnapshot(Runtime, 42)).resolves.toBeNull();
  });

  test("allows unknown-turn snapshots when no freshness floor is supplied", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            text: "fallback answer",
            html: "<p>fallback answer</p>",
            messageId: null,
            turnId: null,
            turnIndex: null,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(readAssistantSnapshot(Runtime)).resolves.toEqual(
      expect.objectContaining({ text: "fallback answer", turnIndex: null }),
    );
  });
});
