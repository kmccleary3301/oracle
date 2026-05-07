import { describe, expect, test, vi } from "vitest";
import {
  __test__ as promptComposer,
  insertPromptText,
} from "../../src/browser/actions/promptComposer.js";
import type { BrowserLogger } from "../../src/browser/types.js";

describe("promptComposer", () => {
  test("does not treat cleared composer + stop button as committed without a new turn", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          // Baseline read (turn count)
          .mockResolvedValueOnce({ result: { value: 10 } })
          // Polls (repeat)
          .mockResolvedValue({
            result: {
              value: {
                baseline: 10,
                turnsCount: 10,
                userMatched: false,
                prefixMatched: false,
                lastMatched: false,
                hasNewTurn: false,
                stopVisible: true,
                assistantVisible: false,
                composerCleared: true,
                inConversation: false,
              },
            },
          }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(runtime as never, "hello", 150);
      // Attach the rejection handler before timers advance to avoid unhandled-rejection warnings.
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("allows prompt match even if baseline turn count cannot be read", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        // Baseline read fails
        .mockRejectedValueOnce(new Error("turn read failed"))
        // First poll shows prompt match (baseline unknown)
        .mockResolvedValueOnce({
          result: {
            value: {
              baseline: -1,
              turnsCount: 1,
              userMatched: true,
              prefixMatched: false,
              lastMatched: true,
              hasNewTurn: false,
              stopVisible: false,
              assistantVisible: false,
              composerCleared: false,
              inConversation: true,
            },
          },
        }),
    } as unknown as {
      evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
    };

    await expect(
      promptComposer.verifyPromptCommitted(runtime as never, "hello", 150),
    ).resolves.toBe(1);
  });

  test("falls back when a pasted body drops leading or trailing newlines", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({
            result: { value: { ready: true, composer: true, fileInput: true } },
          })
          .mockResolvedValueOnce({ result: { value: { focused: true } } })
          .mockResolvedValueOnce({
            result: {
              value: {
                inserted: true,
                value: "Hello",
              },
            },
          })
          .mockResolvedValueOnce({
            result: {
              value: {
                editorText: "\nHello\n",
                fallbackValue: "\nHello\n",
                activeValue: "\nHello\n",
              },
            },
          })
          .mockResolvedValueOnce({
            result: {
              value: {
                editorText: "\nHello\n",
                fallbackValue: "\nHello\n",
                activeValue: "\nHello\n",
              },
            },
          }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean; awaitPromise?: boolean }) => Promise<unknown>;
      };
      const input = {
        insertText: vi.fn().mockResolvedValue(undefined),
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
      } as unknown as {
        insertText: ReturnType<typeof vi.fn>;
        dispatchKeyEvent: ReturnType<typeof vi.fn>;
      };
      const logger = vi.fn() as unknown as BrowserLogger;
      const promise = insertPromptText(
        {
          runtime: runtime as never,
          input: input as never,
          inputTimeoutMs: 1_000,
        },
        "\nHello\n",
        logger,
      );
      await vi.advanceTimersByTimeAsync(500);
      await promise;
      expect(input.insertText).toHaveBeenCalledWith({ text: "\nHello\n" });
    } finally {
      vi.useRealTimers();
    }
  });
});
