import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

const {
  launchChrome,
  connectWithNewTab,
  closeTab,
  monitorLocalChromeProcess,
  readDevToolsPort,
  readChromePid,
  writeDevToolsActivePort,
  writeChromePid,
  cleanupStaleProfileState,
  verifyDevToolsReachable,
} = vi.hoisted(() => ({
  launchChrome: vi.fn(),
  connectWithNewTab: vi.fn(),
  closeTab: vi.fn(async () => undefined),
  monitorLocalChromeProcess: vi.fn(),
  readDevToolsPort: vi.fn<() => Promise<number | null>>(async () => null),
  readChromePid: vi.fn<() => Promise<number | null>>(async () => null),
  writeDevToolsActivePort: vi.fn(async () => undefined),
  writeChromePid: vi.fn(async () => undefined),
  cleanupStaleProfileState: vi.fn(async () => undefined),
  verifyDevToolsReachable: vi.fn<() => Promise<{ ok: boolean; error?: string }>>(async () => ({
    ok: false,
    error: "unreachable",
  })),
}));

vi.mock("../../src/browser/chromeLifecycle.js", () => ({
  launchChrome,
  connectWithNewTab,
  closeTab,
  monitorLocalChromeProcess,
}));

vi.mock("../../src/browser/profileState.js", () => ({
  readDevToolsPort,
  readChromePid,
  writeDevToolsActivePort,
  writeChromePid,
  cleanupStaleProfileState,
  verifyDevToolsReachable,
}));

describe("openGeminiBrowserSession", () => {
  const originalProfileDir = process.env.ORACLE_BROWSER_PROFILE_DIR;
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-profile-"));
    delete process.env.ORACLE_BROWSER_PROFILE_DIR;

    launchChrome.mockReset();
    connectWithNewTab.mockReset();
    closeTab.mockClear();
    monitorLocalChromeProcess.mockReset();
    readDevToolsPort.mockReset();
    readChromePid.mockReset();
    writeDevToolsActivePort.mockClear();
    writeChromePid.mockClear();
    cleanupStaleProfileState.mockClear();
    verifyDevToolsReachable.mockReset();

    launchChrome.mockResolvedValue({
      port: 9222,
      pid: 12345,
      kill: vi.fn(),
    });
    connectWithNewTab.mockResolvedValue({
      targetId: "target-1",
      client: {
        close: vi.fn(async () => undefined),
      },
    });
    readDevToolsPort.mockResolvedValue(null);
    readChromePid.mockResolvedValue(null);
    verifyDevToolsReachable.mockResolvedValue({ ok: false, error: "unreachable" });
  });

  afterEach(async () => {
    if (originalProfileDir === undefined) {
      delete process.env.ORACLE_BROWSER_PROFILE_DIR;
    } else {
      process.env.ORACLE_BROWSER_PROFILE_DIR = originalProfileDir;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("prefers an explicit manual-login profile dir over the environment", async () => {
    const explicitDir = path.join(tempRoot, "explicit-profile");
    process.env.ORACLE_BROWSER_PROFILE_DIR = path.join(tempRoot, "env-profile");

    const { openGeminiBrowserSession } =
      await import("../../src/gemini-web/browserSessionManager.js");
    const session = await openGeminiBrowserSession({
      browserConfig: { manualLoginProfileDir: explicitDir },
      keepBrowserDefault: false,
      purpose: "test",
    });

    expect(session.profileDir).toBe(explicitDir);
    expect(launchChrome).toHaveBeenCalledWith(
      expect.objectContaining({
        manualLogin: true,
        manualLoginProfileDir: explicitDir,
      }),
      explicitDir,
      expect.any(Function),
    );
  });

  it("uses ORACLE_BROWSER_PROFILE_DIR when no explicit profile dir is set", async () => {
    const envDir = path.join(tempRoot, "env-profile");
    process.env.ORACLE_BROWSER_PROFILE_DIR = envDir;

    const { openGeminiBrowserSession } =
      await import("../../src/gemini-web/browserSessionManager.js");
    const session = await openGeminiBrowserSession({
      browserConfig: {},
      keepBrowserDefault: true,
      purpose: "test",
    });

    expect(session.profileDir).toBe(envDir);
    expect(launchChrome).toHaveBeenCalledWith(
      expect.objectContaining({
        keepBrowser: true,
        manualLogin: true,
        manualLoginProfileDir: envDir,
      }),
      envDir,
      expect.any(Function),
    );
  });

  it("ignores blank environment profile dirs and falls back to the default", async () => {
    process.env.ORACLE_BROWSER_PROFILE_DIR = "   ";
    const homedir = path.join(tempRoot, "home");
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(homedir);
    const defaultDir = path.join(homedir, ".oracle", "browser-profile");

    const { openGeminiBrowserSession } =
      await import("../../src/gemini-web/browserSessionManager.js");
    const session = await openGeminiBrowserSession({
      browserConfig: {},
      keepBrowserDefault: false,
      purpose: "test",
    });

    expect(session.profileDir).toBe(defaultDir);
    expect(launchChrome).toHaveBeenCalledWith(
      expect.objectContaining({
        manualLogin: true,
        manualLoginProfileDir: defaultDir,
      }),
      defaultDir,
      expect.any(Function),
    );
    homedirSpy.mockRestore();
  });

  it("refuses to reuse an unidentifiable Chrome process", async () => {
    readDevToolsPort.mockResolvedValue(9222);
    verifyDevToolsReachable.mockResolvedValue({ ok: true });

    const { openGeminiBrowserSession } =
      await import("../../src/gemini-web/browserSessionManager.js");
    await expect(
      openGeminiBrowserSession({
        browserConfig: { manualLoginProfileDir: tempRoot },
        keepBrowserDefault: true,
        purpose: "test",
      }),
    ).rejects.toThrow("root PID is unavailable for memory monitoring");

    expect(connectWithNewTab).not.toHaveBeenCalled();
  });

  it("monitors reused Chrome until the Gemini session closes", async () => {
    const stopResourceWatchdog = vi.fn();
    readDevToolsPort.mockResolvedValue(9222);
    readChromePid.mockResolvedValue(12345);
    verifyDevToolsReachable.mockResolvedValue({ ok: true });
    monitorLocalChromeProcess.mockResolvedValue({
      resourceExhaustion: new Promise<never>(() => undefined),
      stopResourceWatchdog,
    });

    const { openGeminiBrowserSession } =
      await import("../../src/gemini-web/browserSessionManager.js");
    const session = await openGeminiBrowserSession({
      browserConfig: { manualLoginProfileDir: tempRoot },
      keepBrowserDefault: true,
      purpose: "test",
    });
    await session.close();

    expect(monitorLocalChromeProcess).toHaveBeenCalledWith(
      expect.objectContaining({ port: 9222, pid: 12345, profileDir: tempRoot }),
    );
    expect(stopResourceWatchdog).toHaveBeenCalledOnce();
  });
});
