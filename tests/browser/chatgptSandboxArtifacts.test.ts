import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildSandboxArtifactIdentity,
  dedupeSandboxArtifactRefs,
  extractSandboxArtifactRefsFromRuntime,
  resolveSandboxArtifactOutputDir,
  waitForNewSandboxArtifactRefsFromRuntime,
} from "../../src/browser/chatgpt/sandboxArtifacts.ts";
import type { ChromeClient } from "../../src/browser/types.js";

describe("ChatGPT sandbox artifact helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("normalizes artifact refs returned from the page runtime", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              label: "frontend codebase zip",
              turnIndex: 3,
              turnId: "turn-3",
              messageId: "msg-3",
              documentIndex: 7,
            },
            {
              label: "   ",
            },
          ],
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const refs = await extractSandboxArtifactRefsFromRuntime(Runtime);

    expect(refs).toEqual([
      {
        label: "frontend codebase zip",
        turnIndex: 3,
        turnId: "turn-3",
        messageId: "msg-3",
        documentIndex: 7,
      },
    ]);
    expect(buildSandboxArtifactIdentity(refs[0])).toBe(
      "msg-3::turn-3::3::7::frontend codebase zip",
    );
  });

  test("waits for new refs beyond the baseline set", async () => {
    vi.useFakeTimers();
    const Runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          result: {
            value: [
              {
                label: "README",
                turnIndex: 1,
                turnId: "turn-1",
                messageId: "msg-1",
                documentIndex: 0,
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          result: {
            value: [
              {
                label: "README",
                turnIndex: 1,
                turnId: "turn-1",
                messageId: "msg-1",
                documentIndex: 0,
              },
              {
                label: "implementation manifest",
                turnIndex: 2,
                turnId: "turn-2",
                messageId: "msg-2",
                documentIndex: 1,
              },
            ],
          },
        }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForNewSandboxArtifactRefsFromRuntime(
      Runtime,
      [
        {
          label: "README",
          turnIndex: 1,
          turnId: "turn-1",
          messageId: "msg-1",
          documentIndex: 0,
        },
      ],
      1_000,
    );
    await vi.advanceTimersByTimeAsync(450);

    await expect(promise).resolves.toEqual([
      {
        label: "implementation manifest",
        turnIndex: 2,
        turnId: "turn-2",
        messageId: "msg-2",
        documentIndex: 1,
      },
    ]);
  });

  test("derives the default artifact output directory from the conversation id", () => {
    const outputDir = resolveSandboxArtifactOutputDir(
      undefined,
      "https://chatgpt.com/c/69e7da3a-8218-83ea-a974-5c2b2d54146a",
    );

    expect(outputDir).toContain("oracle-chatgpt-artifacts");
    expect(outputDir).toContain("69e7da3a-8218-83ea-a974-5c2b2d54146a");
  });

  test("dedupes nested duplicate refs and prefers the entry with a message id", () => {
    const refs = dedupeSandboxArtifactRefs([
      {
        label: "README",
        turnIndex: 2,
        turnId: "conversation-turn-2",
        messageId: null,
        documentIndex: 0,
      },
      {
        label: "README",
        turnIndex: 3,
        turnId: null,
        messageId: "03f79032-ef34-418a-8eed-279e6095e6f6",
        documentIndex: 4,
      },
    ]);

    expect(refs).toEqual([
      {
        label: "README",
        turnIndex: 3,
        turnId: null,
        messageId: "03f79032-ef34-418a-8eed-279e6095e6f6",
        documentIndex: 4,
      },
    ]);
  });
});
