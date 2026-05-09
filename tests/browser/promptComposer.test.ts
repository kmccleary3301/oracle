import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  __test__ as promptComposer,
  insertPromptText,
} from "../../src/browser/actions/promptComposer.js";
import type { BrowserLogger } from "../../src/browser/types.js";

describe("promptComposer", () => {
  test("reconstructs ProseMirror paragraph readback without inflated blank lines", () => {
    const fixture = readFileSync("tests/fixtures/structured-request-body.md", "utf8").replace(
      /\n$/,
      "",
    );
    const lines = fixture.split("\n");
    const readValue = new Function(
      "node",
      `
      const Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
      class HTMLTextAreaElement {}
      ${promptComposer.buildComposerReadValueFunction()}
      return readValue(node);
      `,
    ) as (node: unknown) => string;

    const proseMirrorNode = {
      childNodes: lines.map((line) => ({
        nodeType: 1,
        nodeName: "P",
        textContent: line.replaceAll(" ", "\u00a0"),
        childNodes: [
          {
            nodeType: 3,
            nodeName: "#text",
            textContent: line.replaceAll(" ", "\u00a0"),
          },
        ],
      })),
      innerText: lines.join("\n\n\n"),
      textContent: lines.join(""),
    };

    expect(readValue(proseMirrorNode)).toBe(fixture);
  });

  test("reconstructs hard line breaks inside a single ProseMirror paragraph", () => {
    const readValue = new Function(
      "node",
      `
      const Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
      class HTMLTextAreaElement {}
      ${promptComposer.buildComposerReadValueFunction()}
      return readValue(node);
      `,
    ) as (node: unknown) => string;

    const hardBreakNode = {
      childNodes: [
        {
          nodeType: 1,
          nodeName: "P",
          childNodes: [
            { nodeType: 3, nodeName: "#text", textContent: "line 1" },
            { nodeType: 1, nodeName: "BR", childNodes: [], textContent: "" },
            { nodeType: 3, nodeName: "#text", textContent: "line 2" },
            { nodeType: 1, nodeName: "BR", childNodes: [], textContent: "" },
            { nodeType: 1, nodeName: "BR", childNodes: [], textContent: "" },
            { nodeType: 3, nodeName: "#text", textContent: "line 4" },
          ],
        },
      ],
      innerText: "line 1\nline 2\n\nline 4",
      textContent: "line 1line 2line 4",
    };

    expect(readValue(hardBreakNode)).toBe("line 1\nline 2\n\nline 4");
  });

  test("uses hard line breaks before falling back to CDP insertText", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({
            result: { value: { ready: true, composer: true, fileInput: true } },
          })
          .mockResolvedValueOnce({ result: { value: { focused: true } } })
          .mockResolvedValueOnce({ result: { value: { inserted: true, value: "A\nB" } } })
          .mockResolvedValueOnce({
            result: {
              value: {
                editorText: "A\nB",
                fallbackValue: "",
                activeValue: "A\nB",
              },
            },
          })
          .mockResolvedValueOnce({
            result: {
              value: {
                editorText: "A\nB",
                fallbackValue: "",
                activeValue: "A\nB",
              },
            },
          }),
      } as unknown as {
        evaluate: (args: {
          expression: string;
          returnByValue?: boolean;
          awaitPromise?: boolean;
        }) => Promise<unknown>;
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
        "A\nB",
        logger,
      );
      await vi.advanceTimersByTimeAsync(500);
      await promise;
      expect(input.insertText).not.toHaveBeenCalled();
      expect(logger).toHaveBeenCalledWith("Inserted prompt via contenteditable hard line breaks");
    } finally {
      vi.useRealTimers();
    }
  });

  test("uses native paste attachment path for large multiline prompts", async () => {
    const largePrompt = `${"A\nB\n".repeat(5_100)}done`;
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          result: { value: { ready: true, composer: true, fileInput: true } },
        })
        .mockResolvedValueOnce({ result: { value: { focused: true } } })
        .mockResolvedValueOnce({ result: { value: { ok: true, previousText: "old clipboard" } } })
        .mockResolvedValueOnce({
          result: { value: { value: "", pastedAttachment: true, exact: false } },
        })
        .mockResolvedValueOnce({
          result: { value: true },
        })
        .mockResolvedValueOnce({
          result: {
            value: {
              editorText: "",
              fallbackValue: "",
              activeValue: "",
            },
          },
        })
        .mockResolvedValueOnce({
          result: {
            value: {
              editorText: "",
              fallbackValue: "",
              activeValue: "",
            },
          },
        }),
    } as unknown as {
      evaluate: (args: {
        expression: string;
        returnByValue?: boolean;
        awaitPromise?: boolean;
      }) => Promise<unknown>;
    };
    const input = {
      insertText: vi.fn().mockResolvedValue(undefined),
      dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as {
      insertText: ReturnType<typeof vi.fn>;
      dispatchKeyEvent: ReturnType<typeof vi.fn>;
    };
    const browser = {
      grantPermissions: vi.fn().mockResolvedValue(undefined),
    } as unknown as {
      grantPermissions: ReturnType<typeof vi.fn>;
    };
    const logger = vi.fn() as unknown as BrowserLogger;
    await insertPromptText(
      {
        runtime: runtime as never,
        input: input as never,
        browser: browser as never,
        inputTimeoutMs: 1_000,
      },
      largePrompt,
      logger,
    );
    expect(browser.grantPermissions).toHaveBeenCalledWith({
      origin: "https://chatgpt.com",
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    expect(input.insertText).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith("Inserted prompt via ChatGPT pasted-text attachment");
  });

  test("tries native clipboard paste before editor-specific insertion", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          result: { value: { ready: true, composer: true, fileInput: true } },
        })
        .mockResolvedValueOnce({ result: { value: { focused: true } } })
        .mockResolvedValueOnce({ result: { value: { ok: true, previousText: "old clipboard" } } })
        .mockResolvedValueOnce({
          result: { value: { value: "plain prompt", pastedAttachment: false, exact: true } },
        })
        .mockResolvedValueOnce({
          result: { value: true },
        })
        .mockResolvedValueOnce({
          result: {
            value: {
              editorText: "plain prompt",
              fallbackValue: "",
              activeValue: "plain prompt",
            },
          },
        })
        .mockResolvedValueOnce({
          result: {
            value: {
              editorText: "plain prompt",
              fallbackValue: "",
              activeValue: "plain prompt",
            },
          },
        }),
    } as unknown as {
      evaluate: (args: {
        expression: string;
        returnByValue?: boolean;
        awaitPromise?: boolean;
      }) => Promise<unknown>;
    };
    const input = {
      insertText: vi.fn().mockResolvedValue(undefined),
      dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as {
      insertText: ReturnType<typeof vi.fn>;
      dispatchKeyEvent: ReturnType<typeof vi.fn>;
    };
    const browser = {
      grantPermissions: vi.fn().mockResolvedValue(undefined),
    } as unknown as {
      grantPermissions: ReturnType<typeof vi.fn>;
    };
    const logger = vi.fn() as unknown as BrowserLogger;
    await insertPromptText(
      {
        runtime: runtime as never,
        input: input as never,
        browser: browser as never,
        inputTimeoutMs: 1_000,
      },
      "plain prompt",
      logger,
    );

    expect(input.dispatchKeyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ commands: ["paste"], key: "v" }),
    );
    expect(input.insertText).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith("Inserted prompt via native clipboard paste");
  });

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

  test("accepts durable conversation submission when pasted text attachment creates a new turn", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        // Baseline read
        .mockResolvedValueOnce({ result: { value: 10 } })
        // First poll after send: URL is durable and request body is a pasted-text attachment.
        .mockResolvedValueOnce({
          result: {
            value: {
              baseline: 10,
              turnsCount: 11,
              userMatched: false,
              prefixMatched: false,
              lastMatched: false,
              hasNewTurn: true,
              stopVisible: false,
              assistantVisible: false,
              composerCleared: true,
              inConversation: true,
              hasPastedTextAttachment: true,
            },
          },
        }),
    } as unknown as {
      evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
    };

    await expect(
      promptComposer.verifyPromptCommitted(runtime as never, "hello", 150),
    ).resolves.toBe(11);
  });

  test("does not accept old assistant content as durable submission evidence", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({ result: { value: 10 } })
          .mockResolvedValue({
            result: {
              value: {
                baseline: 10,
                turnsCount: 10,
                userMatched: false,
                prefixMatched: false,
                lastMatched: false,
                hasNewTurn: false,
                stopVisible: false,
                assistantVisible: true,
                composerCleared: true,
                inConversation: true,
                hasPastedTextAttachment: true,
              },
            },
          }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(runtime as never, "hello", 150);
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

  test("inserts raw prompt text through CDP without using synthetic paste", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({
            result: { value: { ready: true, composer: true, fileInput: true } },
          })
          .mockResolvedValueOnce({ result: { value: { focused: true } } })
          .mockResolvedValueOnce({ result: { value: { inserted: false, value: "" } } })
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
        evaluate: (args: {
          expression: string;
          returnByValue?: boolean;
          awaitPromise?: boolean;
        }) => Promise<unknown>;
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
      expect(input.insertText).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
