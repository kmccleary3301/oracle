import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  dedupeGeneratedImageRecords,
  extractGeneratedImageFileId,
  isLikelyChatgptGeneratedImageUrl,
} from "../../src/browser/chatgpt/imageArtifacts.ts";
import type { ChatgptImageDomRecord } from "../../src/browser/chatgpt/types.ts";

function record(partial: Partial<ChatgptImageDomRecord>): ChatgptImageDomRecord {
  return {
    fileId: partial.fileId ?? "file_abc",
    src: partial.src ?? "https://chatgpt.com/backend-api/estuary/content?id=file_abc",
    renderedWidth: partial.renderedWidth ?? 0,
    renderedHeight: partial.renderedHeight ?? 0,
    area: partial.area ?? 0,
    documentIndex: partial.documentIndex ?? 0,
    isThumbnail: partial.isThumbnail ?? false,
    turnId: partial.turnId ?? null,
    messageId: partial.messageId ?? null,
    turnIndex: partial.turnIndex ?? null,
    ancestorSummary: partial.ancestorSummary ?? [],
  };
}

describe("ChatGPT generated image artifact helpers", () => {
  test("extracts generated file ids from ChatGPT estuary URLs", () => {
    const url =
      "https://chatgpt.com/backend-api/estuary/content?id=file_000000009f0c71f78a1184c4d28dd7b5&ts=1&p=fs";

    expect(extractGeneratedImageFileId(url)).toBe(
      "file_000000009f0c71f78a1184c4d28dd7b5",
    );
    expect(isLikelyChatgptGeneratedImageUrl(url)).toBe(true);
  });

  test("rejects non-ChatGPT generated image URLs", () => {
    expect(extractGeneratedImageFileId("https://example.com/image.png")).toBeNull();
    expect(isLikelyChatgptGeneratedImageUrl("https://example.com/?id=file_abc")).toBe(false);
  });

  test("dedupes repeated DOM nodes by file id and keeps the largest representative", () => {
    const images = dedupeGeneratedImageRecords([
      record({
        fileId: "file_one",
        src: "https://chatgpt.com/backend-api/estuary/content?id=file_one&v=thumb",
        renderedWidth: 48,
        renderedHeight: 48,
        area: 2_304,
        documentIndex: 0,
        isThumbnail: true,
      }),
      record({
        fileId: "file_two",
        src: "https://chatgpt.com/backend-api/estuary/content?id=file_two",
        renderedWidth: 480,
        renderedHeight: 340,
        area: 163_200,
        documentIndex: 1,
      }),
      record({
        fileId: "file_one",
        src: "https://chatgpt.com/backend-api/estuary/content?id=file_one",
        renderedWidth: 480,
        renderedHeight: 340,
        area: 163_200,
        documentIndex: 2,
      }),
    ]);

    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({
      fileId: "file_one",
      sourceUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_one",
      duplicateNodeCount: 2,
      variantIndex: 0,
      renderedWidth: 480,
      renderedHeight: 340,
    });
    expect(images[1]).toMatchObject({
      fileId: "file_two",
      duplicateNodeCount: 1,
      variantIndex: 1,
    });
  });

  test("dedupes the sanitized Images 2.0 sample fixture to seven logical outputs", () => {
    const fixturePath = path.join(
      process.cwd(),
      "tests/fixtures/chatgpt/images-2-sample-dom-records.json",
    );
    const records = JSON.parse(readFileSync(fixturePath, "utf8")) as ChatgptImageDomRecord[];
    const images = dedupeGeneratedImageRecords(records);

    expect(records).toHaveLength(24);
    expect(images.map((image) => image.fileId)).toEqual([
      "file_000000009f0c71f78a1184c4d28dd7b5",
      "file_00000000c15c71f7977fa0629231c1af",
      "file_00000000c21c71f7a05f6d4ac424ac91",
      "file_00000000fd0871f58ec5aaa3765496ce",
      "file_00000000934471f5934a410525c8ff2c",
      "file_000000006f5c71f79de5ee9d8163ddb6",
      "file_0000000020f871f78710b9237d400647",
    ]);
    expect(images.map((image) => image.duplicateNodeCount)).toEqual([6, 3, 3, 3, 3, 3, 3]);
  });
});
