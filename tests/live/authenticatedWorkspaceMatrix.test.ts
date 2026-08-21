import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getCookies } from "@steipete/sweet-cookie";
import {
  launchChrome,
  connectToChrome,
  connectToRemoteChrome,
  closeRemoteChromeTarget,
  positionChromeWindowOffscreen,
} from "../../src/browser/chromeLifecycle.js";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import { syncCookies } from "../../src/browser/cookies.js";
import { CHATGPT_URL } from "../../src/browser/constants.js";
import { navigateToChatGPT } from "../../src/browser/actions/navigation.js";
import { readChatgptCapabilityProbe } from "../../src/browser/chatgpt/probe.js";
import { readResearchSnapshot } from "../../src/browser/chatgpt/research.js";
import { listChatgptImageLibraryFromConfiguredBrowser } from "../../src/browser/chatgpt/imageService.js";
import { listChatgptProjects, readChatgptProject } from "../../src/browser/chatgpt/projects.js";
import { preflightChatgptFile } from "../../src/browser/chatgpt/files.js";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";
import type { ChatgptCapabilityProbeResult } from "../../src/browser/chatgpt/types.js";

const LIVE = process.env.ORACLE_LIVE_TEST === "1";
const ARTIFACT_PATH =
  process.env.ORACLE_AUTH_MATRIX_ARTIFACT ??
  ".oracle-benchmarks/authenticated-workspace-matrix.json";
const logger = (() => undefined) as BrowserLogger;

type MatrixStatus =
  | "ok"
  | "partial"
  | "unsupported"
  | "unavailable"
  | "login_required"
  | "challenge_required"
  | "disconnected"
  | "conflict"
  | "unknown";

interface MatrixEntry {
  status: MatrixStatus;
  reason?:
    | "configuration_missing"
    | "connection_failed"
    | "navigation_failed"
    | "unsupported_ui"
    | "no_observed_project"
    | "stale_revision"
    | "disconnect";
}

interface MatrixArtifact {
  schemaVersion: 1;
  kind: "authenticated-workspace-matrix";
  capturedAt: string;
  evidence: {
    source: "live";
    sessionCookie: "present" | "absent" | "unavailable";
    accountSelector: MatrixEntry & { capability: "observed" | "unsupported" | "unavailable" };
    personalDefault: MatrixEntry & {
      pageIdentity: ChatgptCapabilityProbeResult["page"]["identityClass"];
      authState: ChatgptCapabilityProbeResult["auth"]["state"];
      capabilityStatus: ChatgptCapabilityProbeResult["status"];
      modes: string[];
      models: string[];
      effort: string[];
      uploads: ChatgptCapabilityProbeResult["controls"]["uploads"];
    };
    configuredProjectWorkspace: MatrixEntry & {
      configured: boolean;
      attempted: boolean;
      pageIdentity?: ChatgptCapabilityProbeResult["page"]["identityClass"];
      authState?: ChatgptCapabilityProbeResult["auth"]["state"];
      capabilityStatus?: ChatgptCapabilityProbeResult["status"];
    };
    projects: {
      list: MatrixEntry & { count: number; attempted: boolean };
      get: MatrixEntry & { attempted: boolean; source: "configured" | "listed_fallback" | "none" };
    };
    surfaces: {
      research: MatrixEntry & { operation: "status" };
      files: MatrixEntry & { operation: "control" };
      images: MatrixEntry & { operation: "status"; entryCount: number };
    };
  };
  fixtureEvidence: Array<{
    case: "missing_project_url" | "disconnect" | "stale_revision" | "unsupported_ui";
    status: "covered";
    testPath: string;
  }>;
}

interface RemoteBrowser {
  host: string;
  port: number;
  kill: () => Promise<void>;
  profileDir: string;
}

function classifyError(error: unknown): MatrixEntry {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/disconnect|target closed|websocket|connection lost|network/.test(message))
    return { status: "disconnected", reason: "disconnect" };
  if (/revision|stale/.test(message)) return { status: "conflict", reason: "stale_revision" };
  if (/unsupported|not supported|unavailable|not found/.test(message))
    return { status: "unsupported", reason: "unsupported_ui" };
  if (/login|sign.?in|auth|challenge/.test(message)) return { status: "login_required" };
  return { status: "unavailable", reason: "navigation_failed" };
}

function probeEntry(
  probe: ChatgptCapabilityProbeResult,
): MatrixArtifact["evidence"]["personalDefault"] {
  return {
    status: probe.status,
    pageIdentity: probe.page.identityClass,
    authState: probe.auth.state,
    capabilityStatus: probe.status,
    modes: probe.controls.modes,
    models: probe.controls.models,
    effort: probe.controls.effort,
    uploads: probe.controls.uploads,
    ...(probe.failure
      ? {
          reason:
            probe.failure.code === "configuration_missing"
              ? "configuration_missing"
              : probe.failure.code === "connection_failed"
                ? "connection_failed"
                : probe.failure.code === "navigation_failed"
                  ? "navigation_failed"
                  : undefined,
        }
      : {}),
  };
}

async function readSessionCookie(
  remote?: Pick<RemoteBrowser, "host" | "port">,
): Promise<MatrixArtifact["evidence"]["sessionCookie"]> {
  if (remote) {
    let client: ChromeClient | null = null;
    try {
      client = await connectToChrome(remote.port, logger, remote.host);
      await client.Network.enable();
      const { cookies } = await client.Network.getCookies({
        urls: ["https://chatgpt.com", "https://auth.openai.com"],
      });
      return cookies.some((cookie) => cookie.name.startsWith("__Secure-next-auth.session-token"))
        ? "present"
        : "absent";
    } catch {
      return "unavailable";
    } finally {
      await client?.close().catch(() => undefined);
    }
  }
  try {
    const { cookies } = await getCookies({
      url: CHATGPT_URL,
      origins: ["https://chatgpt.com", "https://chat.openai.com", "https://atlas.openai.com"],
      browsers: ["chrome"],
      mode: "merge",
      chromeProfile: "Default",
      timeoutMs: 5_000,
    });
    return cookies.some((cookie) => cookie.name.startsWith("__Secure-next-auth.session-token"))
      ? "present"
      : "absent";
  } catch {
    return "unavailable";
  }
}

async function startAuthenticatedBrowser(): Promise<RemoteBrowser> {
  const remoteEndpoint = process.env.ORACLE_AUTH_MATRIX_REMOTE_CHROME?.trim();
  if (remoteEndpoint) {
    const match = remoteEndpoint.match(/^(?<host>[^:]+):(?<port>\d+)$/);
    const port = Number(match?.groups?.port);
    if (!match?.groups?.host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(
        "ORACLE_AUTH_MATRIX_REMOTE_CHROME must be a host:port Chrome DevTools endpoint.",
      );
    }
    return {
      host: match.groups.host,
      port,
      profileDir: process.env.ORACLE_BROWSER_PROFILE_DIR?.trim() || "remote",
      kill: async () => undefined,
    };
  }
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-auth-matrix-"));
  const config = resolveBrowserConfig({
    chromeProfile: "Default",
    headless: false,
    hideWindow: true,
    cookieSync: false,
  });
  const chrome = await launchChrome(config, profileDir, logger);
  const host = (chrome as { host?: string }).host ?? "127.0.0.1";
  const client = await connectToChrome(chrome.port, logger, host);
  try {
    await client.Network.enable();
    await syncCookies(client.Network, CHATGPT_URL, "Default", logger, {
      filterNames: config.cookieNames,
      allowErrors: true,
    });
    await positionChromeWindowOffscreen(client, logger);
  } finally {
    await client.close();
  }
  return {
    host,
    port: chrome.port,
    profileDir,
    kill: async () => {
      try {
        await chrome.kill();
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
  };
}

async function withReadOnlyPage<T>(
  remote: { host: string; port: number },
  fn: (client: ChromeClient) => Promise<T>,
): Promise<T> {
  const connection = await connectToRemoteChrome(remote.host, remote.port, logger, CHATGPT_URL);
  try {
    await Promise.all([connection.client.Page.enable(), connection.client.Runtime.enable()]);
    await navigateToChatGPT(connection.client.Page, connection.client.Runtime, CHATGPT_URL, logger);
    return await fn(connection.client);
  } finally {
    try {
      await connection.client.close();
    } finally {
      await closeRemoteChromeTarget(remote.host, remote.port, connection.targetId, logger).catch(
        () => undefined,
      );
    }
  }
}

async function readAccountSelector(remote: {
  host: string;
  port: number;
}): Promise<MatrixArtifact["evidence"]["accountSelector"]> {
  try {
    const value = await withReadOnlyPage(remote, async (client) => {
      const outcome = await client.Runtime.evaluate({
        expression: `(() => {
          const visible = (node) => { if (!(node instanceof HTMLElement)) return false; const rect = node.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return false; const style = getComputedStyle(node); return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'; };
          const nodes = Array.from(document.querySelectorAll('[aria-label], [data-testid], button, [role="button"]'));
          const count = nodes.filter((node) => visible(node) && /account|profile|switch-account|user-menu/i.test(String(node.getAttribute('aria-label') || node.getAttribute('data-testid') || ''))).length;
          return { count };
        })()`,
        returnByValue: true,
      });
      return outcome.result?.value as { count?: number } | undefined;
    });
    return value?.count
      ? { status: "ok", capability: "observed" }
      : { status: "unsupported", reason: "unsupported_ui", capability: "unsupported" };
  } catch (error) {
    return { ...classifyError(error), capability: "unavailable" };
  }
}

async function readResearchAndFileControls(remote: { host: string; port: number }): Promise<{
  research: MatrixEntry & { operation: "status" };
  files: MatrixEntry & { operation: "control" };
}> {
  try {
    const result = await withReadOnlyPage(remote, async (client) => {
      const research = await readResearchSnapshot(client.Runtime);
      const fileControls = await client.Runtime.evaluate({
        expression: `(() => ({ file: Boolean(document.querySelector('input[type="file"], [data-testid*="upload" i], [aria-label*="upload" i]')), image: Boolean(document.querySelector('[data-testid*="image" i], [aria-label*="image" i]')) }))()`,
        returnByValue: true,
      });
      return {
        research,
        file: fileControls.result?.value as { file?: boolean; image?: boolean } | undefined,
      };
    });
    return {
      research:
        result.research.state === "unsupported"
          ? { status: "unsupported", reason: "unsupported_ui", operation: "status" }
          : {
              status: result.research.state === "conflict" ? "conflict" : "ok",
              operation: "status",
            },
      files: result.file?.file
        ? { status: "ok", operation: "control" }
        : { status: "unsupported", reason: "unsupported_ui", operation: "control" },
    };
  } catch (error) {
    const failure = classifyError(error);
    return {
      research: { ...failure, operation: "status" },
      files: { ...failure, operation: "control" },
    };
  }
}

async function runMatrix(): Promise<MatrixArtifact> {
  const capturedAt = new Date().toISOString();
  const remote = await startAuthenticatedBrowser();
  const sessionCookie = await readSessionCookie(remote);
  try {
    const remoteConfig = {
      remoteChrome: { host: remote.host, port: remote.port },
      chatgptUrl: CHATGPT_URL,
    };
    const personalProbe = await readChatgptCapabilityProbe({
      config: remoteConfig,
      timeoutMs: 30_000,
    });
    const personalDefault = probeEntry(personalProbe);
    const accountSelector = await readAccountSelector(remote);
    const configuredUrl =
      process.env.ORACLE_CHATGPT_PROJECT_URL?.trim() ||
      process.env.ORACLE_CHATGPT_WORKSPACE_URL?.trim();
    let configuredProjectWorkspace: MatrixArtifact["evidence"]["configuredProjectWorkspace"] =
      configuredUrl
        ? { configured: true, attempted: true, status: "unavailable", reason: "navigation_failed" }
        : {
            configured: false,
            attempted: false,
            status: "unavailable",
            reason: "configuration_missing",
          };
    if (configuredUrl) {
      const configuredProbe = await readChatgptCapabilityProbe({
        config: { ...remoteConfig, chatgptUrl: configuredUrl },
        timeoutMs: 30_000,
      });
      configuredProjectWorkspace = {
        configured: true,
        attempted: true,
        status: configuredProbe.status,
        pageIdentity: configuredProbe.page.identityClass,
        authState: configuredProbe.auth.state,
        capabilityStatus: configuredProbe.status,
        ...(configuredProbe.failure
          ? {
              reason:
                configuredProbe.failure.code === "configuration_missing"
                  ? "configuration_missing"
                  : configuredProbe.failure.code === "connection_failed"
                    ? "connection_failed"
                    : configuredProbe.failure.code === "navigation_failed"
                      ? "navigation_failed"
                      : undefined,
            }
          : {}),
      };
    }

    let listedProjects: Awaited<ReturnType<typeof listChatgptProjects>> | null = null;
    let list: MatrixArtifact["evidence"]["projects"]["list"];
    try {
      listedProjects = await listChatgptProjects({ config: remoteConfig, timeoutMs: 30_000 });
      list = { status: "ok", count: listedProjects.projects.length, attempted: true };
    } catch (error) {
      list = { ...classifyError(error), count: 0, attempted: true };
    }
    const projectUrl =
      configuredUrl || listedProjects?.projects.find((project) => Boolean(project.url))?.url;
    let get: MatrixArtifact["evidence"]["projects"]["get"] = {
      status: "unavailable",
      reason: "no_observed_project",
      attempted: false,
      source: "none",
    };
    if (projectUrl) {
      try {
        await readChatgptProject({ projectUrl, config: remoteConfig, timeoutMs: 30_000 });
        get = {
          status: "ok",
          attempted: true,
          source: configuredUrl ? "configured" : "listed_fallback",
        };
      } catch (error) {
        get = {
          ...classifyError(error),
          attempted: true,
          source: configuredUrl ? "configured" : "listed_fallback",
        };
      }
    }
    const controls = await readResearchAndFileControls(remote);
    let images: MatrixArtifact["evidence"]["surfaces"]["images"];
    try {
      const result = await listChatgptImageLibraryFromConfiguredBrowser({
        config: remoteConfig,
        timeoutMs: 30_000,
      });
      images = {
        status: result.state === "completed" ? "ok" : "partial",
        operation: "status",
        entryCount: result.entries.length,
      };
    } catch (error) {
      images = { ...classifyError(error), operation: "status", entryCount: 0 };
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oracle-auth-matrix-file-"));
    try {
      const fixtureFile = path.join(tempDir, "probe.txt");
      await writeFile(fixtureFile, "non-sensitive preflight fixture\n", "utf8");
      const preflight = await preflightChatgptFile(fixtureFile, { supportedExtensions: [".txt"] });
      controls.files =
        preflight.status === "accepted"
          ? { status: "ok", operation: "control" }
          : { status: "unsupported", reason: "unsupported_ui", operation: "control" };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    const artifact: MatrixArtifact = {
      schemaVersion: 1,
      kind: "authenticated-workspace-matrix",
      capturedAt,
      evidence: {
        source: "live",
        sessionCookie,
        accountSelector,
        personalDefault,
        configuredProjectWorkspace,
        projects: { list, get },
        surfaces: { research: controls.research, files: controls.files, images },
      },
      fixtureEvidence: [
        {
          case: "missing_project_url",
          status: "covered",
          testPath: "tests/live/browser-fast-live.test.ts",
        },
        { case: "disconnect", status: "covered", testPath: "tests/browser/cdpLiveness.test.ts" },
        {
          case: "stale_revision",
          status: "covered",
          testPath: "tests/browser/projectLifecycle.test.ts",
        },
        {
          case: "unsupported_ui",
          status: "covered",
          testPath: "tests/browser/projectLifecycle.test.ts",
        },
      ],
    };
    await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
    await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    return artifact;
  } finally {
    await remote.kill();
  }
}

(LIVE ? describe : describe.skip)("ChatGPT authenticated workspace matrix", () => {
  test(
    "captures sanitized account, context, project, and read-only surface evidence",
    async () => {
      const artifact = await runMatrix();
      expect(artifact.schemaVersion).toBe(1);
      expect(artifact.evidence.personalDefault).toHaveProperty("status");
      expect(artifact.evidence.configuredProjectWorkspace).toHaveProperty("status");
      expect(JSON.stringify(artifact)).not.toMatch(/chatgpt\.com\/g\//i);
      expect(JSON.stringify(artifact)).not.toMatch(/private|secret|cookie=/i);
    },
    4 * 60 * 1000,
  );
});
