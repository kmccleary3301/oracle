import { describe, expect, it } from "vitest";
import {
  extractChatgptResponseOutput,
  sanitizeAssistantHtml,
} from "../../src/browser/actions/responseOutput.js";

describe("ChatGPT response output extraction", () => {
  it("sanitizes dangerous HTML while preserving Unicode and URLs", () => {
    const html =
      '<p>雪 ☃️</p><script>alert("x")</script><a href="https://example.test/a?q=1&x=2" onclick="steal()" title="Résumé">Link</a><form><input></form><style>body{}</style>';
    const output = extractChatgptResponseOutput({
      html,
      turnId: "turn-1",
      messageId: "message-1",
      turnIndex: 2,
      conversationUrl: "https://chatgpt.com/c/c-1",
      conversationId: "c-1",
    });

    expect(output.sanitizedHtml).toContain("雪 ☃️");
    expect(output.sanitizedHtml).toContain("https://example.test/a?q=1&x=2");
    expect(output.sanitizedHtml).not.toMatch(/script|onclick|<form|<style/i);
    expect(output.citations).toEqual([
      expect.objectContaining({
        href: "https://example.test/a?q=1&x=2",
        text: "Link",
        title: "Résumé",
        turnId: "turn-1",
        messageId: "message-1",
        turnIndex: 2,
      }),
    ]);
    expect(output.provenance).toMatchObject({
      source: "chatgpt-dom",
      conversationId: "c-1",
      turnId: "turn-1",
      messageId: "message-1",
      turnIndex: 2,
    });
    expect(JSON.stringify(output)).not.toContain('"answerText"');
  });

  it("extracts code, tables, files, and images with turn association", () => {
    const output = extractChatgptResponseOutput({
      html: '<pre><code class="language-ts">const π = "雪";</code></pre><table><tr><th>Name</th><th>Value</th></tr><tr><td>α</td><td>1</td></tr></table><a href="https://files.test/report.pdf">report.pdf</a><img src="https://img.test/a.png" alt="雪" title="plot">',
      turnId: "turn-9",
      messageId: "message-9",
      turnIndex: 9,
    });

    expect(output.codeBlocks).toEqual([
      expect.objectContaining({
        language: "ts",
        code: 'const π = "雪";',
        turnId: "turn-9",
        messageId: "message-9",
        turnIndex: 9,
      }),
    ]);
    expect(output.tables).toEqual([
      expect.objectContaining({ headers: ["Name", "Value"], rows: [["α", "1"]], turnId: "turn-9" }),
    ]);
    expect(output.fileRefs).toEqual([
      expect.objectContaining({
        href: "https://files.test/report.pdf",
        name: "report.pdf",
        messageId: "message-9",
      }),
    ]);
    expect(output.imageRefs).toEqual([
      expect.objectContaining({
        src: "https://img.test/a.png",
        alt: "雪",
        title: "plot",
        turnIndex: 9,
      }),
    ]);
  });

  it("keeps serialization stable and excludes full answer text", () => {
    const output = extractChatgptResponseOutput({
      html: "<p>answer</p>",
      turnId: "t",
      messageId: "m",
    });
    const parsed = JSON.parse(JSON.stringify(output)) as Record<string, unknown>;

    expect(parsed.sanitizedHtml).toBe("<p>answer</p>");
    expect(parsed).not.toHaveProperty("answerText");
    expect(parsed).not.toHaveProperty("answerMarkdown");
  });

  it("removes javascript URLs and active attributes", () => {
    expect(sanitizeAssistantHtml('<a href="javascript:alert(1)" onmouseover="x()">bad</a>')).toBe(
      "<a>bad</a>",
    );
  });
});
