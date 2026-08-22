import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApprovalGrantAuthority } from "../../src/browser/approvalToken.ts";
import { describe, expect, test } from "vitest";
import {
  appendImageHistory,
  approvalChallengeForImageHistory,
  classifyImageError,
  createImageHistory,
  dedupeImageLibraryEntries,
  downloadChatgptImage,
  editChatgptImage,
  generateChatgptImage,
  imageOutputMetadata,
  verifyChatgptImageMode,
  interruptChatgptImage,
  isExactImageModeEvidence,
  normalizeImageLibraryEntries,
  normalizeImageModeObservation,
  redoImageHistory,
  selectImageSource,
  stableOrderAndDedupeImages,
  undoImageHistory,
} from "../../src/browser/chatgpt/imageService.ts";
import type { ChatgptGeneratedImage } from "../../src/browser/chatgpt/types.ts";
import type { ChatgptImageTarget } from "../../src/browser/chatgpt/imageTypes.ts";

function image(
  fileId: string,
  width: number,
  height: number,
  turnIndex: number,
): ChatgptGeneratedImage {
  return {
    fileId,
    sourceUrl: `https://chatgpt.com/backend-api/estuary/content?id=${fileId}`,
    turnId: `turn-${turnIndex}`,
    messageId: `message-${turnIndex}`,
    turnIndex,
    variantIndex: 0,
    renderedWidth: width,
    renderedHeight: height,
    isThumbnail: false,
    duplicateNodeCount: 1,
    domRecords: [],
  };
}

describe("ChatGPT image lifecycle service", () => {
  test("does not claim unsupported or unselected image mode is verified", () => {
    const unavailable = normalizeImageModeObservation({
      pageIdentity: "chatgpt_app",
      loginLikely: true,
      availableModes: ["chat", "search"],
      selectedMode: "chat",
    });
    expect(unavailable.supported).toBe(false);
    expect(isExactImageModeEvidence(unavailable)).toBe(false);

    const unselected = normalizeImageModeObservation({
      pageIdentity: "chatgpt_app",
      loginLikely: true,
      availableModes: ["chat", "images"],
      selectedMode: "chat",
    });
    expect(unselected.supported).toBe(true);
    expect(unselected.verified).toBe(false);
  });

  test("verifies the dedicated Images 2.0 generator route as Images mode", async () => {
    const document = {
      title: "ChatGPT Images 2.0 | AI Image Generator",
      body: { innerText: "Create images" },
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    const Runtime = {
      evaluate: async ({ expression }: { expression: string }) => ({
        result: {
          value: Function(
            "document",
            "location",
            `return ${expression}`,
          )(document, {
            pathname: "/images/",
            hostname: "chatgpt.com",
          }),
        },
      }),
    };

    await expect(verifyChatgptImageMode(Runtime as never)).resolves.toMatchObject({
      supported: true,
      verified: true,
      selectedMode: "images",
      availableModes: ["images"],
      pageIdentity: "chatgpt_app",
      loginLikely: true,
    });
  });

  test("requires observed Images mode before submitting and succeeds when verified", async () => {
    let sends = 0;
    const evidence = normalizeImageModeObservation({
      pageIdentity: "chatgpt_app",
      loginLikely: true,
      availableModes: ["chat", "images"],
      selectedMode: "images",
    });
    const result = await generateChatgptImage({
      prompt: "make an icon",
      modeEvidence: evidence,
      requireVerifiedMode: true,
      createSession: async () => {
        sends += 1;
        return {
          answerText: "",
          answerMarkdown: "",
          tookMs: 1,
          warnings: [],
          generatedImages: [image("file_verified", 1024, 1024, 1)],
          newGeneratedImages: [image("file_verified", 1024, 1024, 1)],
        } as never;
      },
    });
    expect(result.state).toBe("completed");
    expect(sends).toBe(1);
    expect(result.outputs?.[0]?.fileId).toBe("file_verified");
  });

  test("does not submit when Images mode is not selected", async () => {
    let sends = 0;
    const result = await generateChatgptImage({
      prompt: "make an icon",
      modeEvidence: normalizeImageModeObservation({
        pageIdentity: "chatgpt_app",
        loginLikely: true,
        availableModes: ["chat", "images"],
        selectedMode: "chat",
      }),
      requireVerifiedMode: true,
      createSession: async () => {
        sends += 1;
        return {} as never;
      },
    });
    expect(result.state).toBe("unsupported");
    expect(result.failure?.code).toBe("mode_unverified");
    expect(sends).toBe(0);
  });

  test("reports text-only completion as unsupported", async () => {
    const result = await generateChatgptImage({
      prompt: "describe an icon",
      modeEvidence: normalizeImageModeObservation({
        pageIdentity: "chatgpt_app",
        loginLikely: true,
        availableModes: ["images"],
        selectedMode: "images",
      }),
      requireVerifiedMode: true,
      createSession: async () =>
        ({
          answerText: "It is a lovely icon.",
          answerMarkdown: "It is a lovely icon.",
          tookMs: 1,
          warnings: [],
          generatedImages: [],
          newGeneratedImages: [],
        }) as never,
    });
    expect(result.state).toBe("unsupported");
    expect(result.failure?.code).toBe("no_image_artifacts");
  });

  test("edit preserves exact source artifact identity", async () => {
    const source = stableOrderAndDedupeImages([image("file_source", 1024, 1024, 7)])[0]!;
    const result = await editChatgptImage({
      prompt: "adjust the colors",
      target: { fileId: source.fileId, turnId: source.turnId, messageId: source.messageId },
      existingImages: [source],
      modeEvidence: normalizeImageModeObservation({
        pageIdentity: "chatgpt_app",
        loginLikely: true,
        availableModes: ["images"],
        selectedMode: "images",
      }),
      requireVerifiedMode: true,
      createSession: async () =>
        ({
          answerText: "",
          answerMarkdown: "",
          tookMs: 1,
          warnings: [],
          generatedImages: [source],
          newGeneratedImages: [source],
        }) as never,
    });
    expect(result.state).toBe("completed");
    expect(result.outputs?.[0]).toMatchObject({
      fileId: "file_source",
      turnId: "turn-7",
      messageId: "message-7",
    });
  });

  test("dedupes repeated outputs, keeps full-quality representative, and orders by turn", () => {
    const outputs = stableOrderAndDedupeImages([
      image("file_b", 256, 256, 2),
      image("file_a", 64, 64, 1),
      image("file_a", 1024, 1024, 1),
    ]);
    expect(outputs.map((item) => item.fileId)).toEqual(["file_a", "file_b"]);
    expect(outputs[0]).toMatchObject({ renderedWidth: 1024, outputIndex: 0, variantIndex: 0 });
    expect(outputs[0]).not.toHaveProperty("alt");
    expect(outputs[0]).not.toHaveProperty("title");
  });

  test("preserves exact source identity and requires action for ambiguous targets", () => {
    const outputs = stableOrderAndDedupeImages([
      image("file_a", 1024, 1024, 1),
      image("file_b", 512, 512, 2),
    ]);
    const selected = selectImageSource(outputs, {
      fileId: "file_b",
      turnId: "turn-2",
      messageId: "message-2",
    });
    expect(selected.status).toBe("selected");
    expect(selected.image?.fileId).toBe("file_b");
    expect(selectImageSource(outputs, undefined).status).toBe("requires_action");
  });

  test("dedupes library metadata without retaining private DOM labels", () => {
    const entries = normalizeImageLibraryEntries([
      { fileId: "file_a", sourceUrl: "https://chatgpt.com/a", outputIndex: 1, alt: "private" },
      { fileId: "file_a", sourceUrl: "https://chatgpt.com/a", outputIndex: 0, sha256: "abc" },
    ]);
    expect(dedupeImageLibraryEntries(entries)).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty("alt");
    expect(entries[0]).not.toHaveProperty("title");
  });

  test("undo/redo require exact approval and preserve revision outputs", () => {
    const authority = new ApprovalGrantAuthority({ dbPath: ":memory:" });
    const target: ChatgptImageTarget = { fileId: "file_a", revisionHash: "rev-1" };
    const first = appendImageHistory(createImageHistory(), {
      target,
      revisionHash: "rev-1",
      outputs: stableOrderAndDedupeImages([image("file_a", 1, 1, 0)]),
    });
    const second = appendImageHistory(first, {
      target: { ...target, revisionHash: "rev-2" },
      revisionHash: "rev-2",
      outputs: stableOrderAndDedupeImages([image("file_b", 1, 1, 1)]),
    });
    expect(undoImageHistory(second).state).toBe("requires_action");
    const challenge = approvalChallengeForImageHistory("undo", second.entries[1]!.target);
    expect(challenge).not.toBeNull();
    if (!challenge) return;
    const issued = authority.issueGrant(challenge, { localOperator: true });
    expect(issued.state).toBe("issued");
    if (issued.state !== "issued") return;
    expect(
      undoImageHistory(second, {
        approvalAuthority: authority,
        approvalChallenge: challenge,
        approvalGrant: issued.grant,
      }).state,
    ).toBe("completed");
    expect(redoImageHistory(first).state).toBe("requires_action");
  });
  test("reports aspect/count metadata and partial output state", async () => {
    const outputs = stableOrderAndDedupeImages([
      image("file_a", 1024, 1024, 1),
      image("file_b", 512, 512, 2),
    ]);
    expect(imageOutputMetadata({ aspectRatio: "1:1", count: 2 }, outputs)).toEqual({
      aspect: { requested: "1:1", actual: "1:1" },
      count: { requested: 2, produced: 2 },
    });
    const partial = await generateChatgptImage({
      prompt: "partial",
      createSession: async () =>
        ({
          answerText: "",
          answerMarkdown: "",
          tookMs: 1,
          warnings: [],
          generatedImages: [],
          newGeneratedImages: [],
        }) as never,
    });
    expect(partial.state).toBe("unsupported");
    expect(partial.failure?.code).toBe("no_image_artifacts");
  });

  test("records full-quality download bytes, MIME, hash, and origin identity", async () => {
    const imageOutput = stableOrderAndDedupeImages([image("file_full", 1024, 1024, 7)])[0]!;
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "oracle-image-"));
    try {
      const runtime = {
        evaluate: async () => ({
          result: {
            value: {
              ok: true,
              base64: Buffer.from("full-quality").toString("base64"),
              mimeType: "image/png",
              width: 1024,
              height: 1024,
            },
          },
        }),
      } as never;
      const result = await downloadChatgptImage({
        Runtime: runtime,
        images: [imageOutput],
        target: { fileId: "file_full", turnId: "turn-7", messageId: "message-7" },
        outputDir,
      });
      expect(result.state).toBe("completed");
      expect(result.value).toMatchObject({
        quality: "full",
        mimeType: "image/png",
        byteSize: 12,
      });
      expect(result.value?.origin).toMatchObject({ turnId: "turn-7", messageId: "message-7" });
      expect(result.value?.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("requires explicit confirmation and targets one image turn for interrupt", async () => {
    const target = { fileId: "file_interrupt", revisionHash: "rev-1" };
    const runtime = {
      evaluate: async () => ({ result: { value: true } }),
    } as never;
    expect((await interruptChatgptImage(runtime, target)).state).toBe("requires_action");
    const authority = new ApprovalGrantAuthority({ dbPath: ":memory:" });
    const challenge = authority.challenge({
      operation: "interrupt",
      target: target.fileId,
      revision: target.revisionHash,
    });
    const issued = authority.issueGrant(challenge, { localOperator: true });
    expect(issued.state).toBe("issued");
    if (issued.state !== "issued") return;
    expect(
      (
        await interruptChatgptImage(runtime, target, {
          confirm: true,
          approvalAuthority: authority,
          approvalChallenge: challenge,
          approvalGrant: issued.grant,
        })
      ).state,
    ).toBe("interrupted");
  });

  test("classifies rate limits and disconnects as recoverable lifecycle states", () => {
    expect(classifyImageError(new Error("HTTP 429 rate limit")).code).toBe("rate_limit");
    expect(classifyImageError(new Error("browser disconnected")).code).toBe("disconnect");
  });
});
