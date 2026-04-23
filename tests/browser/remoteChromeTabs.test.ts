import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

const targetCloseMock = vi.fn();
const cdpCloseMock = vi.fn();
const cdpListMock = vi.fn();
const cdpMock = Object.assign(
  vi.fn().mockResolvedValue({
    Target: {
      closeTarget: targetCloseMock,
    },
    close: vi.fn().mockResolvedValue(undefined),
  }),
  {
    Close: cdpCloseMock,
    List: cdpListMock,
  },
);

vi.mock("chrome-remote-interface", () => ({
  default: cdpMock,
}));

describe("remoteChromeTabs", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-remote-tabs-"));
    setOracleHomeDirOverrideForTest(tmpDir);
    cdpMock.mockClear();
    cdpCloseMock.mockReset();
    cdpListMock.mockReset();
    targetCloseMock.mockReset();
  });

  afterEach(async () => {
    setOracleHomeDirOverrideForTest(null);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("records and forgets tracked targets", async () => {
    const { forgetRemoteChromeTarget, recordRemoteChromeTarget } = await import(
      "../../src/browser/remoteChromeTabs.js"
    );

    await recordRemoteChromeTarget("127.0.0.1", 9222, "target-1", "https://chatgpt.com/c/1");
    await recordRemoteChromeTarget("127.0.0.1", 9222, "target-2", "https://chatgpt.com/c/2");
    await forgetRemoteChromeTarget("127.0.0.1", 9222, "target-1");

    const raw = await fs.readFile(path.join(tmpDir, "remote-chrome-tabs.json"), "utf8");
    expect(raw).toContain("target-2");
    expect(raw).not.toContain("target-1");
  });

  test("prunes oldest tracked tabs to honor the cap", async () => {
    const { pruneRemoteChromeTargets, recordRemoteChromeTarget } = await import(
      "../../src/browser/remoteChromeTabs.js"
    );

    await recordRemoteChromeTarget("127.0.0.1", 9222, "target-1", "https://chatgpt.com/c/1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordRemoteChromeTarget("127.0.0.1", 9222, "target-2", "https://chatgpt.com/c/2");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordRemoteChromeTarget("127.0.0.1", 9222, "target-3", "https://chatgpt.com/c/3");

    cdpListMock.mockResolvedValue([
      { id: "target-1", type: "page", url: "https://chatgpt.com/c/1" },
      { id: "target-2", type: "page", url: "https://chatgpt.com/c/2" },
      { id: "target-3", type: "page", url: "https://chatgpt.com/c/3" },
    ]);
    targetCloseMock.mockResolvedValue({ success: true });

    const logger = vi.fn() as unknown as import("../../src/browser/types.js").BrowserLogger;
    const result = await pruneRemoteChromeTargets("127.0.0.1", 9222, logger, {
      maxTabs: 2,
    });

    expect(result.closedTargetIds).toEqual(["target-1"]);
    expect(targetCloseMock).toHaveBeenCalledWith({ targetId: "target-1" });
  });

  test("reserves a slot before opening a new tab", async () => {
    const { pruneRemoteChromeTargets, recordRemoteChromeTarget } = await import(
      "../../src/browser/remoteChromeTabs.js"
    );

    await recordRemoteChromeTarget("127.0.0.1", 9222, "target-1", "https://chatgpt.com/c/1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordRemoteChromeTarget("127.0.0.1", 9222, "target-2", "https://chatgpt.com/c/2");

    cdpListMock.mockResolvedValue([
      { id: "target-1", type: "page", url: "https://chatgpt.com/c/1" },
      { id: "target-2", type: "page", url: "https://chatgpt.com/c/2" },
    ]);
    targetCloseMock.mockResolvedValue({ success: true });

    const logger = vi.fn() as unknown as import("../../src/browser/types.js").BrowserLogger;
    const result = await pruneRemoteChromeTargets("127.0.0.1", 9222, logger, {
      maxTabs: 2,
      reserveSlots: 1,
    });

    expect(result.closedTargetIds).toEqual(["target-1"]);
  });

  test("prunes untracked ChatGPT tabs when tracked state is empty", async () => {
    const { pruneRemoteChromeTargets } = await import("../../src/browser/remoteChromeTabs.js");

    cdpListMock.mockResolvedValue([
      { id: "target-1", type: "page", url: "https://chatgpt.com/c/1" },
      { id: "target-2", type: "page", url: "https://chatgpt.com/c/2" },
      { id: "target-3", type: "page", url: "https://chatgpt.com/c/3" },
      { id: "target-4", type: "page", url: "https://chatgpt.com/c/4" },
      { id: "target-5", type: "page", url: "https://chatgpt.com/c/5" },
    ]);
    targetCloseMock.mockResolvedValue({ success: true });

    const logger = vi.fn() as unknown as import("../../src/browser/types.js").BrowserLogger;
    const result = await pruneRemoteChromeTargets("127.0.0.1", 9222, logger, {
      maxTabs: 4,
    });

    expect(result.closedTargetIds).toEqual(["target-1"]);
    expect(targetCloseMock).toHaveBeenCalledWith({ targetId: "target-1" });
  });
});
