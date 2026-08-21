import { describe, expect, it, vi } from "vitest";
import { registerChatgptResearchTools } from "../../src/mcp/tools/chatgptResearch.js";

describe("Deep Research MCP tools", () => {
  it("registers each durable lifecycle operation", () => {
    const names: string[] = [];
    const server = { registerTool: vi.fn((name: string) => names.push(name)) };
    registerChatgptResearchTools(server as never);
    expect(names).toEqual([
      "chatgpt_research_start",
      "chatgpt_research_plan",
      "chatgpt_research_get",
      "chatgpt_research_interrupt",
      "chatgpt_research_download",
    ]);
  });
});
