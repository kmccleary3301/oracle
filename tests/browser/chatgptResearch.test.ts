import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildResearchSnapshotExpressionForTest,
  buildResearchSourceSelectionExpressionForTest,
  classifyResearchError,
  classifyResearchSnapshot,
  downloadResearchReport,
  hashResearchPlan,
  planResearch,
} from "../../src/browser/chatgpt/research.js";
import { ApprovalGrantAuthority } from "../../src/browser/approvalToken.js";

describe("ChatGPT Deep Research semantic lifecycle", () => {
  const plan = {
    summary: "Read public sources",
    action: "search and summarize",
    sites: ["example.com"],
    apps: [],
    consequential: false,
    externalWrite: false,
    unknown: false,
    approvePoint: { x: 4, y: 5 },
    editPoint: null,
  };
  it("classifies unavailable mode and user-question/progress states", () => {
    expect(classifyResearchSnapshot({ href: "https://chatgpt.com/c/c1", mode: "chat" }).state).toBe(
      "unsupported",
    );
    expect(
      classifyResearchSnapshot({
        href: "https://chatgpt.com/c/c1",
        mode: "research",
        active: true,
        userQuestion: { id: "q1", question: "Which source?" },
        progress: { state: "running", phase: "reading", percent: 31 },
      }),
    ).toMatchObject({
      state: "waiting_for_user_input",
      userQuestion: { id: "q1" },
      progress: { percent: 31 },
    });
  });
  it("captures a stable plan revision and rejects conversation identity drift", () => {
    const revisionHash = hashResearchPlan(plan);
    expect(
      classifyResearchSnapshot({ href: "https://chatgpt.com/c/c1", mode: "research", plan }).plan
        ?.revisionHash,
    ).toBe(revisionHash);
    expect(
      classifyResearchSnapshot({ href: "https://chatgpt.com/c/c2", mode: "research", plan }, "c1"),
    ).toMatchObject({ state: "conflict", reason: "conversation-mismatch" });
  });
  it("returns dry-run plan preview and detects optimistic hash conflict", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            href: "https://chatgpt.com/c/c1",
            conversationId: "c1",
            mode: "research",
            plan,
          },
        },
      }),
    };
    const preview = await planResearch({
      Runtime: Runtime as never,
      conversationId: "c1",
      dryRun: true,
    });
    expect(preview).toMatchObject({
      state: "waiting_for_plan_approval",
      dryRun: true,
      plan: { revisionHash: hashResearchPlan(plan) },
    });
    const conflict = await planResearch({
      Runtime: Runtime as never,
      conversationId: "c1",
      expectedRevisionHash: "bad",
      dryRun: true,
    });
    expect(conflict).toMatchObject({ state: "conflict", reason: "plan-revision-conflict" });
  });
  it("uses exact approval grant and never approves unknown/consequential plans", async () => {
    const authority = new ApprovalGrantAuthority({ dbPath: ":memory:" });
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            href: "https://chatgpt.com/c/c1",
            conversationId: "c1",
            mode: "research",
            plan,
          },
        },
      }),
    };
    const preview = await planResearch({
      Runtime: Runtime as never,
      conversationId: "c1",
      dryRun: true,
    });
    expect(preview).toMatchObject({
      state: "waiting_for_plan_approval",
      dryRun: true,
      approvalChallenge: { operation: "approve", target: "c1", revision: hashResearchPlan(plan) },
    });
    if (!preview.approvalChallenge) throw new Error("expected approval challenge");
    const issued = authority.issueGrant(preview.approvalChallenge, { localOperator: true });
    expect(issued.state).toBe("issued");
    if (issued.state !== "issued") return;
    const Input = { dispatchMouseEvent: vi.fn() };
    const approved = await planResearch({
      Runtime: Runtime as never,
      conversationId: "c1",
      approve: true,
      approvalChallenge: preview.approvalChallenge,
      approvalGrant: issued.grant,
      approvalAuthority: authority,
      Input: Input as never,
    });
    expect(approved).not.toHaveProperty("approvalChallenge");
    expect(Input.dispatchMouseEvent).toHaveBeenCalled();
    await expect(
      planResearch({
        Runtime: Runtime as never,
        conversationId: "c1",
        approve: true,
        approvalChallenge: preview.approvalChallenge,
        approvalGrant: issued.grant,
        approvalAuthority: authority,
        Input: Input as never,
      }),
    ).resolves.toMatchObject({ state: "requires_action", reason: "approval-grant-replayed" });
    const unknownRuntime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            href: "https://chatgpt.com/c/c1",
            conversationId: "c1",
            mode: "research",
            plan: { ...plan, unknown: true },
          },
        },
      }),
    };
    const unknownPreview = await planResearch({
      Runtime: unknownRuntime as never,
      conversationId: "c1",
      dryRun: true,
    });
    if (!unknownPreview.approvalChallenge) throw new Error("expected unknown-plan challenge");
    const unknownIssued = authority.issueGrant(unknownPreview.approvalChallenge, {
      localOperator: true,
    });
    expect(unknownIssued.state).toBe("issued");
    if (unknownIssued.state !== "issued") return;
    const result = await planResearch({
      Runtime: unknownRuntime as never,
      conversationId: "c1",
      approve: true,
      approvalChallenge: unknownPreview.approvalChallenge,
      approvalGrant: unknownIssued.grant,
      approvalAuthority: authority,
      Input: Input as never,
    });
    expect(result).toMatchObject({
      state: "requires_action",
      reason: "unknown-or-consequential-plan",
    });
  });
  it("keeps source allowlist labels as values rather than selectors", () => {
    const expression = buildResearchSourceSelectionExpressionForTest({
      sites: ["example.com"],
      apps: ["Drive"],
    });
    expect(expression).toContain("example.com");
    expect(expression).toContain("Drive");
    expect(expression).toContain("research-sources");
    expect(expression).not.toContain("querySelector('example.com')");
    expect(buildResearchSnapshotExpressionForTest()).toContain("deep-research-plan");
    expect(buildResearchSnapshotExpressionForTest()).toContain(
      '[data-inline-selection-pill][data-id="plugin:connector_openai_deep_research"]',
    );
  });
  it("classifies retry-after and disconnect with redacted guidance", () => {
    expect(
      classifyResearchError(new Error("429 rate limit; retry after 3s for secret@example.com")),
    ).toMatchObject({ code: "rate-limited", retryable: true, retryAfterMs: 3000 });
    expect(
      classifyResearchError(new Error("websocket disconnect with cookie=secret")),
    ).toMatchObject({ code: "disconnected", retryable: true });
    expect(
      classifyResearchError(new Error("websocket disconnect with cookie=secret")).message,
    ).not.toContain("secret");
  });
  it("writes report Markdown, DOCX, and PDF with byte metadata and hashes", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "oracle-research-"));
    const reports = await downloadResearchReport({
      reportMarkdown: "# Report\n\nA cited answer.",
      outputDir,
      conversationId: "c1",
      turnId: "t1",
      messageId: "m1",
    });
    expect(reports.map((report) => report.format)).toEqual(["markdown", "docx", "pdf"]);
    for (const report of reports) {
      const bytes = await readFile(report.downloadedPath);
      expect(report.byteSize).toBe(bytes.byteLength);
      expect(report.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report.conversationId).toBe("c1");
    }
  });
});
