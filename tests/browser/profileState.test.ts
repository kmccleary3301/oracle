import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as profileState from "../../src/browser/profileState.js";

describe("profileState", () => {
  test("writes DevToolsActivePort to both root and Default", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      const root = path.join(dir, "DevToolsActivePort");
      const nested = path.join(dir, "Default", "DevToolsActivePort");
      expect(existsSync(root)).toBe(true);
      expect(existsSync(nested)).toBe(true);
      expect((await readFile(root, "utf8")).split("\n")[0]?.trim()).toBe("12345");
      expect((await readFile(nested, "utf8")).split("\n")[0]?.trim()).toBe("12345");
      await expect(profileState.readDevToolsPort(dir)).resolves.toBe(12345);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips manual-login cleanup when DevTools port is still reachable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      await expect(
        profileState.shouldCleanupManualLoginProfileState(dir, undefined, {
          connectionClosedUnexpectedly: true,
          probe: async () => ({ ok: true }),
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips normal manual-login cleanup when reused Chrome is still reachable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      await expect(
        profileState.shouldCleanupManualLoginProfileState(dir, undefined, {
          connectionClosedUnexpectedly: false,
          probe: async () => ({ ok: true }),
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs manual-login cleanup when DevTools port is unreachable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      await expect(
        profileState.shouldCleanupManualLoginProfileState(dir, undefined, {
          connectionClosedUnexpectedly: true,
          probe: async () => ({ ok: false, error: "offline" }),
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("matches recorded Chrome commands to the expected profile", () => {
    const dir = "/Users/example/.oracle/browser-profile";
    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${dir}`,
        dir,
      ),
    ).toBe(true);
    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/other",
        dir,
      ),
    ).toBe(false);
    expect(profileState.isChromeCommandForUserDataDirForTest("node worker.js", dir)).toBe(false);
  });

  test("discovers running Chrome DevTools port from process list", () => {
    const dir = "/Users/example/.oracle/browser-profile";
    const processList = `
      123 node worker.js
      456 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=64305 --user-data-dir=${dir} about:blank
      789 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/other
    `;

    expect(
      profileState.findChromeDebugTargetForProfileFromProcessListForTest(processList, dir),
    ).toEqual({
      pid: 456,
      port: 64305,
    });
  });
});
