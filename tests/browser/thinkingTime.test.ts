import { describe, expect, it } from "vitest";
import {
  buildThinkingTimeExpressionForTest,
  ensureThinkingTimeIfAvailable,
} from "../../src/browser/actions/thinkingTime.js";

describe("browser thinking-time selection expression", () => {
  it("uses centralized menu selectors and normalized matching", () => {
    const expression = buildThinkingTimeExpressionForTest();
    expect(expression).toContain("const MENU_CONTAINER_SELECTOR");
    expect(expression).toContain("const MENU_ITEM_SELECTOR");
    expect(expression).toContain('role=\\"menu\\"');
    expect(expression).toContain("data-radix-collection-root");
    expect(expression).toContain('role=\\"menuitem\\"');
    expect(expression).toContain('role=\\"menuitemradio\\"');
    expect(expression).toContain("normalize");
    expect(expression).toContain("extended");
    expect(expression).toContain("standard");
  });

  it("targets the requested thinking time level", () => {
    const levels = ["light", "standard", "extended", "heavy"] as const;
    for (const level of levels) {
      const expression = buildThinkingTimeExpressionForTest(level);
      expect(expression).toContain("const TARGET_LEVEL");
      expect(expression).toContain(`"${level}"`);
    }
  });

  it("returns structured fallback metadata when the chip is unavailable", async () => {
    const runtime = {
      evaluate: async () => ({ result: { value: { status: "chip-not-found" } } }),
    } as any;
    const logger = (() => {}) as any;
    const result = await ensureThinkingTimeIfAvailable(runtime, "heavy", logger);
    expect(result).toEqual({
      requestedThinkingTime: "heavy",
      status: "unavailable",
      fallbackUsed: true,
      reason: "chip-not-found",
    });
  });

  it("returns selected metadata when the requested level is switched", async () => {
    const runtime = {
      evaluate: async () => ({ result: { value: { status: "switched", label: "Heavy" } } }),
    } as any;
    const logger = (() => {}) as any;
    const result = await ensureThinkingTimeIfAvailable(runtime, "heavy", logger);
    expect(result).toMatchObject({
      requestedThinkingTime: "heavy",
      actualThinkingTime: "Heavy",
      status: "selected",
      fallbackUsed: false,
    });
  });
});
