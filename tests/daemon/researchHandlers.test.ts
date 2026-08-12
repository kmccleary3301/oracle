import { describe, expect, it } from "vitest";
import { createResearchDaemonHandlers } from "../../src/daemon/researchHandlers.js";

describe("Deep Research daemon handlers", () => {
  it("exposes durable semantic lifecycle kinds", () => {
    expect(createResearchDaemonHandlers().map((handler) => handler.kind)).toEqual([
      "chatgpt_research_start",
      "chatgpt_research_plan",
      "chatgpt_research_get",
      "chatgpt_research_interrupt",
      "chatgpt_research_download",
    ]);
  });
});
