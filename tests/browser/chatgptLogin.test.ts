import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { beforeEach, describe, expect, test, vi } from "vitest";

const execFileMock = vi.fn();
const detectChromeBinaryMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("../../src/browser/detect.js", () => ({
  detectChromeBinary: detectChromeBinaryMock,
}));

describe("chatgpt login helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  test("keeps the requested profile directory for non-Windows Chrome", async () => {
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    detectChromeBinaryMock.mockResolvedValue({ path: "/usr/bin/google-chrome" });

    const { __test__ } = await import("../../src/browser/chatgpt/login.js");
    const { resolveBrowserConfig } = await import("../../src/browser/config.js");

    const config = resolveBrowserConfig({
      chromePath: "/usr/bin/google-chrome",
      manualLogin: true,
    });
    const logger = vi.fn();
    const requested = "/home/skra/projects/ql_homepage/docs_tmp/oracle/tmp/login-profile-smoke";

    const resolved = await __test__.resolveLocalLoginProfileDir(requested, config, logger);

    expect(resolved).toBe(path.resolve(requested));
    expect(execFileMock).not.toHaveBeenCalled();
    expect(logger).not.toHaveBeenCalled();
  });

  test("maps WSL Windows Chrome profiles to LocalAppData-backed storage", async () => {
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    detectChromeBinaryMock.mockResolvedValue({
      path: "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
    });
    execFileMock.mockImplementation(
      (
        file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        if (file === "cmd.exe") {
          callback(null, {
            stdout: "C:\\Users\\subje\\AppData\\Local\r\n",
            stderr: "",
          });
          return;
        }
        if (file === "wslpath" && args[0] === "-u") {
          callback(null, {
            stdout: "/mnt/c/Users/subje/AppData/Local\n",
            stderr: "",
          });
          return;
        }
        callback(new Error(`Unexpected execFile call: ${file} ${args.join(" ")}`), {
          stdout: "",
          stderr: "",
        });
      },
    );

    const { __test__ } = await import("../../src/browser/chatgpt/login.js");
    const { resolveBrowserConfig } = await import("../../src/browser/config.js");

    const config = resolveBrowserConfig({
      chromePath: "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
      manualLogin: true,
    });
    const logger = vi.fn();
    const requested = "/home/skra/projects/ql_homepage/docs_tmp/oracle/tmp/login-profile-smoke";

    const resolved = await __test__.resolveLocalLoginProfileDir(requested, config, logger);

    expect(resolved).toMatch(
      /^\/mnt\/c\/Users\/subje\/AppData\/Local\/Oracle\/browser-profiles\/login-profile-smoke-[a-f0-9]{10}$/,
    );
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("Windows-local login profile"));
  });

  test("reuses mounted LOCALAPPDATA without calling wslpath", async () => {
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    vi.stubEnv("LOCALAPPDATA", "/mnt/c/Users/subje/AppData/Local");
    detectChromeBinaryMock.mockResolvedValue({
      path: "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
    });

    const { __test__ } = await import("../../src/browser/chatgpt/login.js");
    const { resolveBrowserConfig } = await import("../../src/browser/config.js");

    const config = resolveBrowserConfig({
      chromePath: "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
      manualLogin: true,
    });
    const logger = vi.fn();
    const requested = "/home/skra/projects/ql_homepage/docs_tmp/oracle/tmp/login-profile-smoke";

    const resolved = await __test__.resolveLocalLoginProfileDir(requested, config, logger);

    expect(resolved).toMatch(
      /^\/mnt\/c\/Users\/subje\/AppData\/Local\/Oracle\/browser-profiles\/login-profile-smoke-[a-f0-9]{10}$/,
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("preserves already-mounted Windows profile directories", async () => {
    vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu");
    detectChromeBinaryMock.mockResolvedValue({
      path: "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
    });

    const { __test__ } = await import("../../src/browser/chatgpt/login.js");
    const { resolveBrowserConfig } = await import("../../src/browser/config.js");

    const config = resolveBrowserConfig({
      chromePath: "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
      manualLogin: true,
    });
    const logger = vi.fn();
    const requested = "/mnt/c/Users/subje/AppData/Local/Oracle/browser-profiles/chatgpt-login";

    const resolved = await __test__.resolveLocalLoginProfileDir(requested, config, logger);

    expect(resolved).toBe(requested);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(logger).not.toHaveBeenCalled();
  });

  test("normalizes known auth providers and defaults unknown", async () => {
    const { __test__ } = await import("../../src/browser/chatgpt/login.js");

    expect(
      __test__.normalizeAuthPageState({
        phase: "identifier",
        provider: "google",
      }),
    ).toMatchObject({
      phase: "identifier",
      provider: "google",
    });

    expect(
      __test__.normalizeAuthPageState({
        phase: "unknown",
        provider: "bogus",
      }),
    ).toMatchObject({
      phase: "unknown",
      provider: "unknown",
    });
  });

  test("normalizes auth error text", async () => {
    const { __test__ } = await import("../../src/browser/chatgpt/login.js");

    expect(
      __test__.normalizeAuthPageState({
        phase: "otp",
        provider: "openai",
        errorText: "Incorrect code. Try again.",
      }),
    ).toMatchObject({
      phase: "otp",
      provider: "openai",
      errorText: "Incorrect code. Try again.",
    });
  });

  test("reads optional google credential overrides from dotenv files", async () => {
    const { readChatgptLoginCredentialsFile } = await import("../../src/browser/chatgpt/login.js");
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-login-creds-"));
    const credsFile = path.join(tempDir, "openai.env");

    await fs.writeFile(
      credsFile,
      [
        "OPENAI_EMAIL=native@example.com",
        "OPENAI_PWD=native-password",
        "OPENAI_GOOGLE_EMAIL=google@example.com",
        "OPENAI_GOOGLE_PWD=google-password",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(readChatgptLoginCredentialsFile(credsFile)).resolves.toMatchObject({
      email: "native@example.com",
      password: "native-password",
      googleEmail: "google@example.com",
      googlePassword: "google-password",
    });

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
