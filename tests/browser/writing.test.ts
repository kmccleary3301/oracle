import { describe, expect, test, vi } from "vitest";
import { ApprovalGrantAuthority, type ApprovalChallenge } from "../../src/browser/approvalToken.js";
import {
  ChatgptWritingService,
  computeWritingBlockId,
  extractWritingBlocks,
  writingSnapshotFromMessages,
} from "../../src/browser/chatgpt/writing.js";
import type { WritingBrowserDriver } from "../../src/browser/chatgpt/writingTypes.js";

const html = `<p>Intro prose</p><pre><code class="language-ts">const x = 1 &amp;&amp; 2;</code></pre><table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table><p>Outro</p>`;

function snapshot() {
  return writingSnapshotFromMessages([
    { conversationId: "conv-1", turnId: "turn-1", messageId: "message-1", html },
  ]);
}

function issueGrant(authority: ApprovalGrantAuthority, challenge: ApprovalChallenge): string {
  const issued = authority.issueGrant(challenge, { localOperator: true });
  if (issued.state !== "issued") throw new Error(`approval grant was not issued: ${issued.reason}`);
  return issued.grant;
}

describe("ChatGPT writing extraction", () => {
  test("extracts prose, code, table and response provenance", () => {
    const result = extractWritingBlocks({
      html,
      conversationId: "conv-1",
      turnId: "turn-1",
      messageId: "message-1",
      revisionHash: "rev-1",
    });
    expect(result.blocks.map((block) => block.kind)).toEqual(["prose", "code", "table", "prose"]);
    expect(result.blocks[1]).toMatchObject({
      code: "const x = 1 && 2;",
      language: "ts",
      revisionHash: "rev-1",
    });
    expect(result.blocks[2]).toMatchObject({ headers: ["Name", "Value"], rows: [["A", "1"]] });
    expect(result.provenance).toMatchObject({
      conversationId: "conv-1",
      turnId: "turn-1",
      messageId: "message-1",
    });
  });

  test("duplicate code blocks retain distinct deterministic identities", () => {
    const one = extractWritingBlocks({
      html: '<pre><code class="language-js">a</code></pre><pre><code class="language-js">a</code></pre>',
      conversationId: "c",
      turnId: "t",
      messageId: "m",
      revisionHash: "r",
    }).blocks;
    const two = extractWritingBlocks({
      html: '<pre><code class="language-js">a</code></pre><pre><code class="language-js">a</code></pre>',
      conversationId: "c",
      turnId: "t",
      messageId: "m",
      revisionHash: "r",
    }).blocks;
    expect(one.map((block) => block.blockId)).toEqual(two.map((block) => block.blockId));
    expect(new Set(one.map((block) => block.blockId)).size).toBe(2);
    expect(
      computeWritingBlockId({
        conversationId: "c",
        turnId: "t",
        messageId: "m",
        index: 0,
        language: "js",
        revisionHash: "r",
      }),
    ).not.toBe(
      computeWritingBlockId({
        conversationId: "c",
        turnId: "t",
        messageId: "m",
        index: 1,
        language: "js",
        revisionHash: "r",
      }),
    );
  });
});

describe("ChatgptWritingService", () => {
  test("edit targets only exact block and detects revision conflict", async () => {
    const before = snapshot();
    const code = before.blocks.find((block) => block.kind === "code")!;
    const edit = vi.fn().mockResolvedValue(before);
    const driver: WritingBrowserDriver = { get: vi.fn().mockResolvedValue(before), edit };
    const authority = new ApprovalGrantAuthority({ dbPath: ":memory:" });
    const service = new ChatgptWritingService(driver, undefined, authority);
    const preview = await service.edit({
      conversationId: code.conversationId,
      turnId: code.turnId,
      messageId: code.messageId,
      blockId: code.blockId,
      revisionHash: code.revisionHash,
      content: "const y = 2;",
      dryRun: true,
    });
    const approvalGrant = issueGrant(authority, preview.approvalChallenge!);
    await expect(
      service.edit({
        conversationId: code.conversationId,
        turnId: code.turnId,
        messageId: code.messageId,
        blockId: code.blockId,
        revisionHash: code.revisionHash,
        content: "substituted",
        approvalChallenge: preview.approvalChallenge!,
        approvalGrant,
      }),
    ).resolves.toMatchObject({ status: "requires_action", reason: "approval-grant-mismatch" });
    expect(edit).not.toHaveBeenCalled();
    await expect(
      service.edit({
        conversationId: code.conversationId,
        turnId: code.turnId,
        messageId: code.messageId,
        blockId: code.blockId,
        revisionHash: code.revisionHash,
        content: "const y = 2;",
        approvalChallenge: preview.approvalChallenge!,
        approvalGrant,
      }),
    ).resolves.toMatchObject({ status: "ok" });
    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: code.blockId, revisionHash: code.revisionHash }),
    );
    await expect(
      service.edit({
        conversationId: code.conversationId,
        turnId: code.turnId,
        messageId: code.messageId,
        blockId: code.blockId,
        revisionHash: "stale",
        content: "bad",
      }),
    ).resolves.toMatchObject({ status: "conflict", reason: "revision-mismatch" });
  });
  test("preview never calls edit and run approval is exact", async () => {
    const before = snapshot();
    const code = before.blocks.find((block) => block.kind === "code")!;
    const edit = vi.fn();
    const run = vi.fn().mockResolvedValue({
      runId: "run-1",
      status: "running",
      target: code,
      revisionHash: code.revisionHash,
    });
    const driver: WritingBrowserDriver = { get: vi.fn().mockResolvedValue(before), edit, run };
    const authority = new ApprovalGrantAuthority({ dbPath: ":memory:" });
    const service = new ChatgptWritingService(driver, undefined, authority);
    await expect(
      service.preview({
        conversationId: code.conversationId,
        turnId: code.turnId,
        messageId: code.messageId,
        blockId: code.blockId,
        revisionHash: code.revisionHash,
        content: "preview",
      }),
    ).resolves.toMatchObject({ status: "preview" });
    expect(edit).not.toHaveBeenCalled();
    const dryRun = await service.run({
      conversationId: code.conversationId,
      turnId: code.turnId,
      messageId: code.messageId,
      blockId: code.blockId,
      revisionHash: code.revisionHash,
      dryRun: true,
    });
    expect(dryRun).toMatchObject({
      status: "requires_action",
      dryRun: true,
      approvalChallenge: expect.any(Object),
    });
    const approvalChallenge = dryRun.approvalChallenge!;
    await expect(
      service.run({
        conversationId: code.conversationId,
        turnId: code.turnId,
        messageId: code.messageId,
        blockId: code.blockId,
        revisionHash: code.revisionHash,
        approvalChallenge,
        approvalGrant: "0".repeat(43),
      }),
    ).resolves.toMatchObject({ status: "requires_action", reason: "approval-grant-unknown" });
    const approvalGrant = issueGrant(authority, approvalChallenge);
    await expect(
      service.run({
        conversationId: code.conversationId,
        turnId: code.turnId,
        messageId: code.messageId,
        blockId: code.blockId,
        revisionHash: code.revisionHash,
        approvalChallenge,
        approvalGrant,
      }),
    ).resolves.toMatchObject({ status: "ok", run: { runId: "run-1" } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("stop only interrupts the matching run", async () => {
    const before = snapshot();
    const code = before.blocks.find((block) => block.kind === "code")!;
    const activeRun = {
      runId: "run-1",
      status: "running" as const,
      target: code,
      revisionHash: code.revisionHash,
    };
    const stop = vi.fn().mockResolvedValue(activeRun);
    const driver: WritingBrowserDriver = {
      get: vi.fn().mockResolvedValue({ ...before, activeRun }),
      stop,
    };
    const service = new ChatgptWritingService(driver);
    await expect(
      service.stop({
        conversationId: code.conversationId,
        turnId: code.turnId,
        messageId: code.messageId,
        blockId: code.blockId,
        revisionHash: code.revisionHash,
        runId: "other",
      }),
    ).resolves.toMatchObject({ status: "conflict", reason: "run-mismatch" });
    expect(stop).not.toHaveBeenCalled();
    await expect(
      service.stop({
        conversationId: code.conversationId,
        turnId: code.turnId,
        messageId: code.messageId,
        blockId: code.blockId,
        revisionHash: code.revisionHash,
        runId: "run-1",
      }),
    ).resolves.toMatchObject({ status: "stopped" });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("save/export verifies bytes, hash, MIME and originating message", async () => {
    const before = snapshot();
    const code = before.blocks.find((block) => block.kind === "code")!;
    const bytes = new TextEncoder().encode(code.kind === "code" ? code.code : "");
    const exportBlock = vi.fn().mockResolvedValue({
      bytes,
      mimeType: "text/typescript",
      byteSize: bytes.byteLength,
      sha256: "bad",
      conversationId: code.conversationId,
      turnId: code.turnId,
      messageId: code.messageId,
      blockId: code.blockId,
      provenance: code.provenance,
    });
    const driver: WritingBrowserDriver = {
      get: vi.fn().mockResolvedValue(before),
      export: exportBlock,
    };
    const authority = new ApprovalGrantAuthority({ dbPath: ":memory:" });
    const service = new ChatgptWritingService(driver, undefined, authority);
    const dryRun = await service.codeBlockSave({
      conversationId: code.conversationId,
      turnId: code.turnId,
      messageId: code.messageId,
      blockId: code.blockId,
      revisionHash: code.revisionHash,
      dryRun: true,
      mimeType: "text/typescript",
    });
    expect(dryRun.approvalChallenge).toMatchObject({
      operation: "codeBlock.save",
      target: code.blockId,
      revision: code.revisionHash,
    });
    expect(dryRun).not.toHaveProperty("approvalGrant");
    const approvalChallenge = dryRun.approvalChallenge!;
    const approvalGrant = issueGrant(authority, approvalChallenge);
    await expect(
      service.codeBlockSave({
        conversationId: code.conversationId,
        turnId: code.turnId,
        messageId: code.messageId,
        blockId: code.blockId,
        revisionHash: code.revisionHash,
        approvalChallenge,
        approvalGrant,
        mimeType: "application/json",
      }),
    ).resolves.toMatchObject({ status: "requires_action", reason: "approval-grant-mismatch" });
    expect(exportBlock).not.toHaveBeenCalled();
    await expect(
      service.codeBlockSave({
        conversationId: code.conversationId,
        turnId: code.turnId,
        messageId: code.messageId,
        blockId: code.blockId,
        revisionHash: code.revisionHash,
        approvalChallenge,
        approvalGrant,
        mimeType: "text/typescript",
      }),
    ).resolves.toMatchObject({ status: "conflict", reason: "artifact-verification-failed" });
  });

  test("unsupported UI and disconnect are typed without private page text", async () => {
    const unsupported = writingSnapshotFromMessages([], { writing: false });
    const service = new ChatgptWritingService({ get: vi.fn().mockResolvedValue(unsupported) });
    await expect(service.get({ conversationId: "missing" })).resolves.toMatchObject({
      status: "unsupported",
    });
    await expect(
      new ChatgptWritingService({
        get: vi.fn().mockRejectedValue(new Error("secret page text")),
      }).get({ conversationId: "c" }),
    ).resolves.toMatchObject({ status: "disconnected", reason: "disconnected" });
  });
});
