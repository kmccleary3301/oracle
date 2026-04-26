import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseDotenv } from "dotenv";
import type { LaunchedChrome } from "chrome-launcher";
import CDP from "chrome-remote-interface";
import {
  connectToRemoteChrome,
  ensureWindowsChromeDevtoolsBridge,
  launchChrome,
} from "../chromeLifecycle.js";
import { resolveBrowserConfig } from "../config.js";
import { detectChromeBinary } from "../detect.js";
import { ensureNotBlocked, navigateToChatGPT } from "../actions/navigation.js";
import { delay } from "../utils.js";
import { getOracleHomeDir } from "../../oracleHome.js";
import {
  readChromePid,
  readDevToolsPort,
  verifyDevToolsReachable,
  writeChromePid,
  writeDevToolsActivePort,
} from "../profileState.js";
import type { BrowserAutomationConfig, BrowserLogger, ChromeClient } from "../types.js";

const CHATGPT_LOGIN_URL = "https://chatgpt.com/auth/login";
const DEFAULT_LOGIN_TIMEOUT_MS = 180_000;
const DEFAULT_OTP_TIMEOUT_MS = 120_000;
const execFileAsync = promisify(execFile);

export type ChatgptLoginPhase =
  | "logged_in"
  | "login_cta"
  | "account_picker"
  | "identifier"
  | "password"
  | "otp"
  | "manual_action_required"
  | "unknown";

export interface ChatgptAuthPageState {
  phase: ChatgptLoginPhase;
  provider: "chatgpt" | "openai" | "google" | "unknown";
  href: string;
  title: string;
  readyState: string;
  statusCode?: number;
  loginCtaLabel?: string | null;
  primaryButtonLabel?: string | null;
  accountPickerLabels: string[];
  bodyPreview: string;
  identifierVisible: boolean;
  passwordVisible: boolean;
  otpVisible: boolean;
  manualActionReason?: string | null;
  errorText?: string | null;
}

export interface ChatgptLoginResult {
  status: "already_logged_in" | "awaiting_otp" | "completed" | "needs_manual_action";
  page: ChatgptAuthPageState;
  host: string;
  port: number;
  targetId?: string;
  profileDir?: string | null;
  browserPid?: number;
  continuationId?: string;
  warnings: string[];
}

export interface BeginChatgptTerminalLoginOptions {
  credsFile?: string;
  email?: string;
  password?: string;
  config?: BrowserAutomationConfig;
  timeoutMs?: number;
  log?: BrowserLogger;
  saveState?: boolean;
}

export interface SubmitChatgptLoginOtpOptions {
  code: string;
  timeoutMs?: number;
  log?: BrowserLogger;
}

interface ChatgptLoginCredentials {
  email: string;
  password: string;
  googleEmail?: string;
  googlePassword?: string;
}

interface FillAuthInputResult {
  ok: boolean;
  reason?: string;
  matchedSelector?: string;
}

interface SavedChatgptLoginContinuation {
  id: string;
  createdAt: string;
  host: string;
  port: number;
  targetId?: string;
  profileDir?: string | null;
  browserPid?: number;
  pageHref?: string;
}

interface OpenChatgptLoginSessionResult {
  client: ChromeClient;
  host: string;
  port: number;
  targetId?: string;
  profileDir?: string | null;
  browserPid?: number;
  launchedChrome?: LaunchedChrome;
}

export async function beginChatgptTerminalLogin(
  options: BeginChatgptTerminalLoginOptions,
): Promise<ChatgptLoginResult> {
  const logger = options.log ?? ((_message: string) => {});
  const credentials = await resolveChatgptLoginCredentials(options);
  const chromePath = options.config?.chromePath ?? (await detectChromeBinary()).path ?? null;
  const config = resolveBrowserConfig({
    ...(options.config ?? {}),
    chromePath,
    manualLogin: !options.config?.remoteChrome,
    keepBrowser: true,
    cookieSync: false,
    url: options.config?.url ?? CHATGPT_LOGIN_URL,
    chatgptUrl: options.config?.chatgptUrl ?? CHATGPT_LOGIN_URL,
  });
  const session = await openChatgptLoginSession(config, logger, CHATGPT_LOGIN_URL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;

  try {
    const { Page, Runtime } = session.client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    await navigateToChatGPT(Page, Runtime, CHATGPT_LOGIN_URL, logger);
    await ensureNotBlocked(Runtime, false, logger);
    const result = await driveChatgptLoginToOtp(Runtime, credentials, timeoutMs, logger);
    const warnings = result.warnings;
    if (result.page.phase === "logged_in") {
      await clearSavedChatgptLoginContinuation();
      return {
        status: "completed",
        page: result.page,
        host: session.host,
        port: session.port,
        targetId: session.targetId,
        profileDir: session.profileDir,
        browserPid: session.browserPid,
        warnings,
      };
    }
    if (result.page.phase === "manual_action_required") {
      return {
        status: "needs_manual_action",
        page: result.page,
        host: session.host,
        port: session.port,
        targetId: session.targetId,
        profileDir: session.profileDir,
        browserPid: session.browserPid,
        warnings,
      };
    }
    if (result.page.phase !== "otp") {
      return {
        status: "needs_manual_action",
        page: result.page,
        host: session.host,
        port: session.port,
        targetId: session.targetId,
        profileDir: session.profileDir,
        browserPid: session.browserPid,
        warnings,
      };
    }

    const continuationId =
      options.saveState === false
        ? undefined
        : await saveChatgptLoginContinuation({
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            host: session.host,
            port: session.port,
            targetId: session.targetId,
            profileDir: session.profileDir,
            browserPid: session.browserPid,
            pageHref: result.page.href,
          });

    return {
      status: "awaiting_otp",
      page: result.page,
      host: session.host,
      port: session.port,
      targetId: session.targetId,
      profileDir: session.profileDir,
      browserPid: session.browserPid,
      continuationId,
      warnings,
    };
  } finally {
    await session.client.close().catch(() => undefined);
  }
}

export async function submitChatgptLoginOtp(
  options: SubmitChatgptLoginOtpOptions,
): Promise<ChatgptLoginResult> {
  const logger = options.log ?? ((_message: string) => {});
  const code = options.code.replace(/\s+/g, "").trim();
  if (!/^\d{4,8}$/.test(code)) {
    throw new Error("OTP code must be 4-8 digits.");
  }

  const saved = await loadSavedChatgptLoginContinuation();
  if (!saved) {
    throw new Error("No saved ChatGPT login continuation was found.");
  }
  await ensureSavedLoginDevtoolsReachable(saved, logger);
  const reachable = await verifyDevToolsReachable({
    host: saved.host,
    port: saved.port,
    attempts: 2,
    timeoutMs: 2_000,
  });
  if (!reachable.ok) {
    throw new Error(
      `Saved login browser is no longer reachable at ${saved.host}:${saved.port}: ${reachable.error}`,
    );
  }

  const client = await attachToSavedLoginTarget(saved, logger);
  try {
    const { Runtime, Page } = client;
    await Promise.all([Runtime.enable(), Page.enable()]);
    const pageBefore = await readChatgptAuthPageState(Runtime);
    if (pageBefore.phase === "logged_in") {
      await clearSavedChatgptLoginContinuation();
      return {
        status: "already_logged_in",
        page: pageBefore,
        host: saved.host,
        port: saved.port,
        targetId: saved.targetId,
        profileDir: saved.profileDir,
        browserPid: saved.browserPid,
        warnings: [],
      };
    }
    if (pageBefore.phase !== "otp") {
      throw new Error(
        `Saved login flow is not waiting for OTP (current phase: ${pageBefore.phase}).`,
      );
    }

    const warnings: string[] = [];
    await submitOtpCode(Runtime, code);
    const finalPage = await waitForAuthPhase(Runtime, options.timeoutMs ?? DEFAULT_OTP_TIMEOUT_MS, {
      terminalPhases: ["logged_in", "otp", "manual_action_required"],
      ignoreInitialPhase: "otp",
    });
    if (finalPage.phase === "logged_in") {
      await clearSavedChatgptLoginContinuation();
      return {
        status: "completed",
        page: finalPage,
        host: saved.host,
        port: saved.port,
        targetId: saved.targetId,
        profileDir: saved.profileDir,
        browserPid: saved.browserPid,
        warnings,
      };
    }
    if (finalPage.phase === "otp") {
      warnings.push(
        finalPage.errorText ||
          "OTP submission did not leave the verification screen. The code may have been rejected.",
      );
      return {
        status: "awaiting_otp",
        page: finalPage,
        host: saved.host,
        port: saved.port,
        targetId: saved.targetId,
        profileDir: saved.profileDir,
        browserPid: saved.browserPid,
        continuationId: saved.id,
        warnings,
      };
    }
    return {
      status: "needs_manual_action",
      page: finalPage,
      host: saved.host,
      port: saved.port,
      targetId: saved.targetId,
      profileDir: saved.profileDir,
      browserPid: saved.browserPid,
      warnings,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function loadChatgptLoginState(): Promise<SavedChatgptLoginContinuation | null> {
  return loadSavedChatgptLoginContinuation();
}

export async function clearChatgptLoginState(): Promise<void> {
  await clearSavedChatgptLoginContinuation();
}

export async function resolveChatgptLoginCredentials(
  options: Pick<BeginChatgptTerminalLoginOptions, "credsFile" | "email" | "password">,
): Promise<ChatgptLoginCredentials> {
  const fileCredentials = options.credsFile
    ? await readChatgptLoginCredentialsFile(options.credsFile)
    : {};
  const email = options.email?.trim() || fileCredentials.email || process.env.OPENAI_EMAIL?.trim();
  const password = options.password || fileCredentials.password || process.env.OPENAI_PWD;
  const googleEmail = fileCredentials.googleEmail || process.env.OPENAI_GOOGLE_EMAIL?.trim();
  const googlePassword = fileCredentials.googlePassword || process.env.OPENAI_GOOGLE_PWD;
  if (!email) {
    throw new Error("Missing ChatGPT login email. Pass --email or --creds-file.");
  }
  if (!password) {
    throw new Error("Missing ChatGPT login password. Pass --password or --creds-file.");
  }
  return { email, password, googleEmail, googlePassword };
}

export async function readChatgptLoginCredentialsFile(
  filePath: string,
): Promise<Partial<ChatgptLoginCredentials>> {
  const resolved = path.resolve(filePath);
  const raw = await fs.readFile(resolved);
  const parsed = parseDotenv(raw);
  return {
    email: parsed.OPENAI_EMAIL?.trim(),
    password: parsed.OPENAI_PWD,
    googleEmail: parsed.OPENAI_GOOGLE_EMAIL?.trim(),
    googlePassword: parsed.OPENAI_GOOGLE_PWD,
  };
}

async function driveChatgptLoginToOtp(
  Runtime: ChromeClient["Runtime"],
  credentials: ChatgptLoginCredentials,
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<{ page: ChatgptAuthPageState; warnings: string[] }> {
  const warnings: string[] = [];
  const deadline = Date.now() + timeoutMs;
  let loginCtaClicks = 0;
  let accountPickerClicks = 0;
  let identifierSubmissions = 0;
  let passwordSubmissions = 0;
  let authEntrypointNavigations = 0;
  let lastPhaseKey = "";

  while (Date.now() < deadline) {
    const page = await readChatgptAuthPageState(Runtime);
    const phaseKey = `${page.provider}:${page.phase}:${page.href}`;
    if (phaseKey !== lastPhaseKey) {
      logger(`[login] ${page.provider} ${page.phase} ${page.href}`);
      lastPhaseKey = phaseKey;
    }
    if (
      page.phase === "identifier" &&
      page.provider === "google" &&
      /couldn'?t find your google account|enter a valid email or phone/i.test(
        page.errorText || page.bodyPreview,
      )
    ) {
      warnings.push(
        credentials.googleEmail
          ? "Google rejected the supplied Google identifier. Verify OPENAI_GOOGLE_EMAIL for this ChatGPT account."
          : "Google rejected the supplied identifier. This ChatGPT account likely needs a distinct Google login; set OPENAI_GOOGLE_EMAIL and OPENAI_GOOGLE_PWD to continue non-interactively.",
      );
      return { page, warnings };
    }
    if (
      page.phase === "identifier" &&
      /enter a valid email|couldn'?t find|unknown account|account not found/i.test(
        page.errorText || page.bodyPreview,
      )
    ) {
      warnings.push(page.errorText || "The login identifier was rejected.");
      return { page, warnings };
    }
    if (
      page.phase === "password" &&
      /wrong password|incorrect password|try again|invalid password/i.test(
        page.errorText || page.bodyPreview,
      )
    ) {
      warnings.push(page.errorText || "The login password was rejected.");
      return { page, warnings };
    }
    switch (page.phase) {
      case "logged_in":
      case "otp":
      case "manual_action_required":
        return { page, warnings };
      case "login_cta":
        if (loginCtaClicks < 3) {
          logger("[login] clicking login CTA");
          await clickAuthLoginCta(Runtime);
          loginCtaClicks += 1;
          await delay(1_200);
          continue;
        }
        break;
      case "account_picker":
        if (accountPickerClicks < 3) {
          logger("[login] clicking account picker");
          await clickAccountPicker(Runtime, credentials.email);
          accountPickerClicks += 1;
          await delay(1_200);
          continue;
        }
        break;
      case "identifier":
        if (identifierSubmissions < 3) {
          const identifierValue =
            page.provider === "google"
              ? (credentials.googleEmail ?? credentials.email)
              : credentials.email;
          logger("[login] filling identifier");
          const filled = await fillAuthIdentifier(Runtime, identifierValue);
          if (!filled.ok) {
            logger(`[login] identifier field not ready (${filled.reason ?? "unknown"})`);
            await delay(750);
            continue;
          }
          logger(`[login] identifier filled via ${filled.matchedSelector ?? "unknown selector"}`);
          await delay(250);
          logger("[login] submitting identifier");
          await submitAuthPrimaryAction(Runtime);
          identifierSubmissions += 1;
          await delay(1_500);
          continue;
        }
        break;
      case "password":
        if (passwordSubmissions < 3) {
          const passwordValue =
            page.provider === "google"
              ? (credentials.googlePassword ?? credentials.password)
              : credentials.password;
          logger("[login] filling password");
          const filled = await fillAuthPassword(Runtime, passwordValue);
          if (!filled.ok) {
            logger(`[login] password field not ready (${filled.reason ?? "unknown"})`);
            await delay(750);
            continue;
          }
          logger(`[login] password filled via ${filled.matchedSelector ?? "unknown selector"}`);
          await delay(250);
          logger("[login] submitting password");
          await submitAuthPrimaryAction(Runtime);
          passwordSubmissions += 1;
          await delay(1_500);
          continue;
        }
        break;
      case "unknown":
        if (page.href.startsWith("https://chatgpt.com/") && authEntrypointNavigations < 1) {
          logger("[login] re-navigating auth entrypoint");
          await navigateAuthEntrypoint(Runtime);
          authEntrypointNavigations += 1;
          await delay(1_500);
          continue;
        }
        break;
    }
    await delay(500);
  }

  const page = await readChatgptAuthPageState(Runtime);
  return {
    page,
    warnings: [...warnings, `Timed out waiting for OTP/login state from phase ${page.phase}.`],
  };
}

async function openChatgptLoginSession(
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
  targetUrl: string,
): Promise<OpenChatgptLoginSessionResult> {
  if (config.remoteChrome) {
    const connection = await connectToRemoteChrome(
      config.remoteChrome.host,
      config.remoteChrome.port,
      logger,
      targetUrl,
      { maxTabs: config.remoteChromeMaxTabs },
    );
    return {
      client: connection.client,
      host: config.remoteChrome.host,
      port: config.remoteChrome.port,
      targetId: connection.targetId,
      profileDir: null,
      browserPid: undefined,
    };
  }

  const requestedProfileDir =
    config.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile");
  const profileDir = await resolveLocalLoginProfileDir(requestedProfileDir, config, logger);
  await fs.mkdir(profileDir, { recursive: true });
  const existingPort = await readDevToolsPort(profileDir);
  const existingHost =
    process.env.ORACLE_BROWSER_REMOTE_DEBUG_HOST?.trim() ||
    process.env.WSL_HOST_IP?.trim() ||
    undefined;
  if (existingPort) {
    if (existingHost && existingHost !== "127.0.0.1") {
      await ensureWindowsChromeDevtoolsBridge({
        host: existingHost,
        port: existingPort,
        chromePid: (await readChromePid(profileDir)) ?? undefined,
        logger,
      }).catch(() => undefined);
    }
    const reachable = await verifyDevToolsReachable({
      host: existingHost ?? "127.0.0.1",
      port: existingPort,
      attempts: 2,
      timeoutMs: 2_000,
    });
    if (reachable.ok) {
      const connection = await connectToRemoteChrome(
        existingHost ?? "127.0.0.1",
        existingPort,
        logger,
        targetUrl,
        { maxTabs: config.remoteChromeMaxTabs },
      );
      return {
        client: connection.client,
        host: existingHost ?? "127.0.0.1",
        port: existingPort,
        targetId: connection.targetId,
        profileDir,
        browserPid: (await readChromePid(profileDir)) ?? undefined,
      };
    }
  }

  const chrome = await launchChrome(config, profileDir, logger);
  chrome.process?.unref?.();
  const host = (chrome as { host?: string }).host ?? "127.0.0.1";
  if (chrome.port) {
    await writeDevToolsActivePort(profileDir, chrome.port);
  }
  if (chrome.pid) {
    await writeChromePid(profileDir, chrome.pid);
  }
  const connection = await connectToRemoteChrome(host, chrome.port, logger, targetUrl, {
    maxTabs: config.remoteChromeMaxTabs,
  });
  return {
    client: connection.client,
    host,
    port: chrome.port,
    targetId: connection.targetId,
    profileDir,
    browserPid: chrome.pid,
    launchedChrome: chrome,
  };
}

async function resolveLocalLoginProfileDir(
  requestedProfileDir: string,
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
): Promise<string> {
  const resolved = path.resolve(requestedProfileDir);
  if (!(await shouldUseWindowsLocalProfileDir(config))) {
    return resolved;
  }
  if (isWindowsMountedPath(resolved)) {
    return resolved;
  }

  const localAppData = await readWindowsLocalAppDataPath();
  const localAppDataWsl = isWindowsMountedPath(localAppData)
    ? localAppData
    : await convertWindowsPathToWsl(localAppData);
  const slug = sanitizeProfileLabel(path.basename(resolved) || "browser-profile");
  const hash = crypto.createHash("sha1").update(resolved).digest("hex").slice(0, 10);
  const mapped = path.join(localAppDataWsl, "Oracle", "browser-profiles", `${slug}-${hash}`);
  logger(
    `WSL detected with Windows Chrome; using Windows-local login profile ${mapped} for DevTools compatibility.`,
  );
  return mapped;
}

async function shouldUseWindowsLocalProfileDir(
  config: ReturnType<typeof resolveBrowserConfig>,
): Promise<boolean> {
  if (!isWsl()) {
    return false;
  }
  const chromePath = (config.chromePath?.trim() || (await detectChromeBinary()).path || "").trim();
  return isWindowsChromePath(chromePath);
}

function isWindowsChromePath(candidate: string | null | undefined): boolean {
  const value = (candidate ?? "").trim();
  if (!value) {
    return false;
  }
  if (/[a-z]:\\/i.test(value) && /\.exe$/i.test(value)) {
    return true;
  }
  return /^\/mnt\/[a-z]\//i.test(value) && /\.exe$/i.test(value);
}

function isWindowsMountedPath(candidate: string): boolean {
  return /^\/mnt\/[a-z]\//i.test(candidate);
}

function sanitizeProfileLabel(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "browser-profile";
}

async function readWindowsLocalAppDataPath(): Promise<string> {
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) {
    return localAppData;
  }
  const { stdout } = await execFileAsync(
    "cmd.exe",
    ["/d", "/s", "/c", "cd /d %SystemDrive%\\ >nul 2>&1 && echo %LOCALAPPDATA%"],
    { encoding: "utf8" },
  );
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  let detected: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^[A-Za-z]:\\/.test(lines[index] ?? "")) {
      detected = lines[index];
      break;
    }
  }
  if (!detected) {
    throw new Error("Unable to resolve %LOCALAPPDATA% for Windows Chrome profile launch.");
  }
  return detected;
}

async function convertWindowsPathToWsl(windowsPath: string): Promise<string> {
  if (isWindowsMountedPath(windowsPath)) {
    return windowsPath;
  }
  const { stdout } = await execFileAsync("wslpath", ["-u", windowsPath], { encoding: "utf8" });
  const resolved = stdout.trim();
  if (!resolved) {
    throw new Error(`Unable to map Windows path to WSL path: ${windowsPath}`);
  }
  return resolved;
}

function isWsl(): boolean {
  return (
    process.platform === "linux" &&
    Boolean(process.env.WSL_DISTRO_NAME || os.release().toLowerCase().includes("microsoft"))
  );
}

async function ensureSavedLoginDevtoolsReachable(
  saved: SavedChatgptLoginContinuation,
  logger: BrowserLogger,
): Promise<void> {
  if (!saved.host || saved.host === "127.0.0.1") {
    return;
  }
  await ensureWindowsChromeDevtoolsBridge({
    host: saved.host,
    port: saved.port,
    chromePid: saved.browserPid,
    logger,
  }).catch(() => undefined);
}

async function attachToSavedLoginTarget(
  saved: SavedChatgptLoginContinuation,
  _logger: BrowserLogger,
): Promise<ChromeClient> {
  if (saved.targetId) {
    try {
      return await CDP({ host: saved.host, port: saved.port, target: saved.targetId });
    } catch {
      // fall through
    }
  }
  return await CDP({ host: saved.host, port: saved.port });
}

async function readChatgptAuthPageState(
  Runtime: ChromeClient["Runtime"],
): Promise<ChatgptAuthPageState> {
  const outcome = await Runtime.evaluate({
    expression: buildAuthPageProbeExpression(),
    awaitPromise: true,
    returnByValue: true,
  });
  return normalizeAuthPageState(outcome.result?.value);
}

async function waitForAuthPhase(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  options: {
    terminalPhases: ChatgptLoginPhase[];
    ignoreInitialPhase?: ChatgptLoginPhase;
  },
): Promise<ChatgptAuthPageState> {
  const deadline = Date.now() + timeoutMs;
  let page = await readChatgptAuthPageState(Runtime);
  while (Date.now() < deadline) {
    if (
      options.terminalPhases.includes(page.phase) &&
      (!options.ignoreInitialPhase || page.phase !== options.ignoreInitialPhase)
    ) {
      return page;
    }
    await delay(500);
    page = await readChatgptAuthPageState(Runtime);
  }
  return page;
}

async function clickAuthLoginCta(Runtime: ChromeClient["Runtime"]): Promise<void> {
  await Runtime.evaluate({
    expression: `(() => {
      const selectors = [
        'a[href*="/auth/login"]',
        'a[href*="/auth/signin"]',
        'button[data-testid*="login"]',
        'button[data-testid*="signin"]',
        'button',
        'a',
      ];
      const textMatches = (text) => {
        const normalized = String(text || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        return ['log in', 'login', 'sign in', 'signin'].some((needle) => normalized.startsWith(needle));
      };
      const isVisible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };
      for (const selector of selectors) {
        const candidates = Array.from(document.querySelectorAll(selector));
        for (const candidate of candidates) {
          const label = candidate.textContent || candidate.getAttribute('aria-label') || candidate.getAttribute('title') || '';
          if (isVisible(candidate) && textMatches(label)) {
            candidate.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            if (candidate instanceof HTMLElement) candidate.click();
            return true;
          }
        }
      }
      return false;
    })()`,
    returnByValue: true,
  });
}

async function clickAccountPicker(Runtime: ChromeClient["Runtime"], email: string): Promise<void> {
  await Runtime.evaluate({
    expression: `(() => {
      const normalizedEmail = ${JSON.stringify(email)}.toLowerCase().trim();
      const isVisible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden";
      };
      const candidates = Array.from(
        document.querySelectorAll(
          "[data-identifier], button, [role='button'], a, li, div[role='link'], div[role='button']",
        ),
      ).filter((node) => isVisible(node));
      const labels = candidates.map((node) =>
        String(
          node.getAttribute("data-identifier") ||
            node.getAttribute("data-email") ||
            node.textContent ||
            node.getAttribute("aria-label") ||
            "",
        ).trim(),
      );
      const exact =
        candidates.find((node, index) => labels[index]?.toLowerCase().includes(normalizedEmail)) ??
        candidates.find((node, index) => /@/.test(labels[index] || "")) ??
        null;
      if (exact instanceof HTMLElement) {
        exact.click();
        return true;
      }
      return false;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
}

async function fillAuthIdentifier(
  Runtime: ChromeClient["Runtime"],
  email: string,
): Promise<FillAuthInputResult> {
  return await fillAuthInput(
    Runtime,
    [
      "#identifierId",
      "input[type='email']",
      "input[name='identifier']",
      "input[autocomplete='username']",
      "input[autocomplete='username webauthn']",
      "input[name='email']",
      "input[name='username']",
      "input[id*='email' i]",
    ],
    email,
  );
}

async function fillAuthPassword(
  Runtime: ChromeClient["Runtime"],
  password: string,
): Promise<FillAuthInputResult> {
  return await fillAuthInput(
    Runtime,
    [
      "input[type='password']",
      "input[name='Passwd']",
      "input[autocomplete='current-password']",
      "input[name='password']",
      "input[id*='password' i]",
    ],
    password,
  );
}

async function fillAuthInput(
  Runtime: ChromeClient["Runtime"],
  selectors: string[],
  value: string,
): Promise<FillAuthInputResult> {
  const outcome = await Runtime.evaluate({
    expression: `(() => {
      const candidateSelectors = ${JSON.stringify(selectors)};
      const nextValue = ${JSON.stringify(value)};
      const isVisible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden";
      };
      let matchedSelector = "";
      const target = candidateSelectors
        .map((selector) => ({ selector, node: document.querySelector(selector) }))
        .find((entry) => {
          if (!(entry.node instanceof HTMLInputElement)) return false;
          if (!isVisible(entry.node) || entry.node.disabled) return false;
          matchedSelector = entry.selector;
          return true;
        })?.node ?? null;
      if (!(target instanceof HTMLInputElement)) {
        return {
          ok: false,
          reason: "no_visible_enabled_input",
        };
      }
      target.scrollIntoView?.({ block: "center", inline: "nearest" });
      const prototype = Object.getPrototypeOf(target);
      const descriptor =
        Object.getOwnPropertyDescriptor(prototype, "value") ??
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      target.focus();
      target.select?.();
      if (descriptor?.set) {
        descriptor.set.call(target, nextValue);
      } else {
        target.value = nextValue;
      }
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        ok: true,
        matchedSelector,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (outcome.exceptionDetails) {
    const description =
      outcome.exceptionDetails.exception?.description ||
      outcome.exceptionDetails.exception?.value ||
      outcome.exceptionDetails.text ||
      "unknown error";
    throw new Error(`Failed to evaluate auth input helper: ${description}`);
  }
  const valueResult = outcome.result?.value;
  if (!valueResult || typeof valueResult !== "object") {
    return { ok: false, reason: "missing_result" };
  }
  return {
    ok: Boolean((valueResult as { ok?: unknown }).ok),
    reason:
      typeof (valueResult as { reason?: unknown }).reason === "string"
        ? (valueResult as { reason?: string }).reason
        : undefined,
    matchedSelector:
      typeof (valueResult as { matchedSelector?: unknown }).matchedSelector === "string"
        ? (valueResult as { matchedSelector?: string }).matchedSelector
        : undefined,
  };
}

async function submitAuthPrimaryAction(Runtime: ChromeClient["Runtime"]): Promise<void> {
  await Runtime.evaluate({
    expression: `(() => {
      const isVisible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };
      const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      const providerButtonPattern = /continue with (google|apple|phone)/i;
      const focusTarget =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const focusedForm =
        focusTarget?.closest('form') ??
        document.querySelector("input[type='password']")?.closest("form") ??
        document.querySelector("#identifierId")?.closest("form") ??
        document.querySelector("input[name='Passwd']")?.closest("form") ??
        document.querySelector("input[type='email']")?.closest("form") ??
        null;
      if (focusedForm instanceof HTMLFormElement) {
        const submitControl = focusedForm.querySelector("button[type='submit'], input[type='submit']");
        if (submitControl instanceof HTMLElement && !submitControl.hasAttribute('disabled') && isVisible(submitControl)) {
          submitControl.click();
          return true;
        }
        focusedForm.requestSubmit?.();
        return true;
      }
      const exactLabels = new Set(['continue', 'next', 'verify', 'submit', 'log in', 'sign in']);
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'));
      const target =
        buttons.find((node) => {
          const label = normalize(node.textContent || node.getAttribute('value') || node.getAttribute('aria-label') || '');
          return (
            isVisible(node) &&
            !node.hasAttribute('disabled') &&
            exactLabels.has(label) &&
            !providerButtonPattern.test(label)
          );
        }) ??
        buttons.find((node) => {
          const label = normalize(node.textContent || node.getAttribute('value') || node.getAttribute('aria-label') || '');
          return isVisible(node) && !node.hasAttribute('disabled') && !providerButtonPattern.test(label);
        }) ??
        null;
      if (target instanceof HTMLElement) {
        target.click();
        return true;
      }
      return false;
    })()`,
    returnByValue: true,
  });
}

async function submitOtpCode(Runtime: ChromeClient["Runtime"], code: string): Promise<void> {
  const { result, exceptionDetails } = await Runtime.evaluate({
    expression: `(() => {
      const otpCode = ${JSON.stringify(code)};
      const isVisible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden";
      };
      const directInput =
        document.querySelector("input[autocomplete='one-time-code']") ??
        document.querySelector("input[name='idvPin']") ??
        document.querySelector("input[name='totpPin']") ??
        document.querySelector("input[type='tel']") ??
        document.querySelector("input[name*='code' i]") ??
        document.querySelector("input[name*='pin' i]") ??
        document.querySelector("input[id*='code' i]") ??
        document.querySelector("input[id*='pin' i]");
      const digits = otpCode.split("");
      const assignValue = (target, nextValue) => {
        const prototype = Object.getPrototypeOf(target);
        const descriptor =
          Object.getOwnPropertyDescriptor(prototype, "value") ??
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        target.focus();
        if (descriptor?.set) {
          descriptor.set.call(target, nextValue);
        } else {
          target.value = nextValue;
        }
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
      };
      if (directInput instanceof HTMLInputElement && isVisible(directInput)) {
        assignValue(directInput, otpCode);
      } else {
        const segmented = Array.from(
          document.querySelectorAll("input[inputmode='numeric'], input[pattern='[0-9]*']"),
        ).filter((node) => isVisible(node));
        if (segmented.length >= digits.length) {
          segmented.slice(0, digits.length).forEach((node, index) => {
            if (node instanceof HTMLInputElement) {
              assignValue(node, digits[index] || "");
            }
          });
        } else {
          return false;
        }
      }
      const buttons = Array.from(document.querySelectorAll("button, input[type='submit'], [role='button']"));
      const submit =
        buttons.find((node) => {
          const label = String(node.textContent || node.getAttribute("value") || node.getAttribute("aria-label") || "")
            .toLowerCase()
            .replace(/\\s+/g, " ")
            .trim();
          return ["continue", "verify", "submit", "next"].some((needle) => label === needle || label.startsWith(needle));
        }) ?? null;
      if (submit instanceof HTMLElement && !submit.hasAttribute("disabled")) {
        submit.click();
      }
      return true;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    const description =
      exceptionDetails.exception?.description ||
      exceptionDetails.exception?.value ||
      exceptionDetails.text ||
      "unknown error";
    throw new Error(`Failed to evaluate the OTP helper: ${description}`);
  }
  if (!result?.value) {
    throw new Error("Failed to populate the ChatGPT OTP field.");
  }
}

async function navigateAuthEntrypoint(Runtime: ChromeClient["Runtime"]): Promise<void> {
  await Runtime.evaluate({
    expression: `(() => {
      location.href = ${JSON.stringify(CHATGPT_LOGIN_URL)};
      return true;
    })()`,
    returnByValue: true,
  });
}

function buildAuthPageProbeExpression(): string {
  return `(async () => {
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const bodyText = normalize(document.body?.innerText || '');
    const href = typeof location === 'object' && location?.href ? location.href : '';
    const hostname = typeof location === 'object' && location?.hostname ? location.hostname : '';
    const title = document.title || '';
    const readyState = document.readyState || '';
    const isGoogleAuthHost = /(^|\\.)accounts\\.google\\.com$/i.test(hostname);
    const isOpenAiAuthHost = /(^|\\.)auth\\.openai\\.com$/i.test(hostname);
    const isChatgptHost = /(^|\\.)chatgpt\\.com$/i.test(hostname);
    let statusCode = 0;
    let meHasSession = false;
    try {
      if (typeof fetch === 'function' && isChatgptHost) {
        const response = await fetch('/backend-api/me', {
          cache: 'no-store',
          credentials: 'include',
        });
        statusCode = response.status || 0;
        if (response.ok) {
          const contentType = String(response.headers.get('content-type') || '').toLowerCase();
          if (contentType.includes('application/json')) {
            const payload = await response.json().catch(() => null);
            const root = payload && typeof payload === 'object' ? payload : null;
            const nestedUser = root && typeof root.user === 'object' ? root.user : null;
            const rootEmail = typeof root?.email === 'string' ? root.email : '';
            const nestedEmail = typeof nestedUser?.email === 'string' ? nestedUser.email : '';
            meHasSession =
              Boolean(rootEmail.includes('@') || nestedEmail.includes('@')) ||
              Array.isArray(root?.accounts) ||
              Boolean(root?.account_plan || root?.session);
          }
        }
      }
    } catch {
      statusCode = 0;
      meHasSession = false;
    }

    const promptReady = (() => {
      const selectors = ${JSON.stringify([
        "textarea",
        "[contenteditable='true']",
        "[data-testid='prompt-textarea']",
      ])};
      return selectors.some((selector) => {
        const node = document.querySelector(selector);
        return node && isVisible(node) && !node.hasAttribute('disabled');
      });
    })();

    const accountPickerLabels = Array.from(
      document.querySelectorAll('[data-identifier], button, [role="button"], a, li, div[role="link"], div[role="button"]'),
    )
      .map((node) =>
        normalize(
          node.getAttribute('data-identifier') ||
          node.getAttribute('data-email') ||
          node.getAttribute('aria-label') ||
          node.textContent ||
          '',
        ),
      )
      .filter((label) => /@/.test(label))
      .slice(0, 10);

    const loginCandidates = Array.from(document.querySelectorAll('button,a,[role="button"]'))
      .map((node) => ({
        label: normalize(node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || ''),
        visible: isVisible(node),
      }))
      .filter((entry) => entry.visible);

    const loginCtaLabel =
      loginCandidates.find((entry) => ['log in', 'login', 'sign in', 'signin'].some((needle) => entry.label.toLowerCase().startsWith(needle)))?.label ?? null;

    const primaryButtonLabel =
      loginCandidates.find((entry) => {
        const label = entry.label.toLowerCase();
        if (/continue with (google|apple|phone)/i.test(entry.label)) return false;
        return ['continue', 'next', 'verify', 'submit', 'log in', 'sign in'].some((needle) => label === needle || label.startsWith(needle));
      })?.label ?? null;

    const identifierVisible = [
      "#identifierId",
      "input[type='email']",
      "input[name='identifier']",
      "input[autocomplete='username']",
      "input[autocomplete='username webauthn']",
      "input[name='email']",
      "input[name='username']",
      "input[id*='email' i]",
    ].some((selector) => {
      const node = document.querySelector(selector);
      return node && isVisible(node) && !node.hasAttribute('disabled');
    });

    const passwordVisible = [
      "input[type='password']",
      "input[name='Passwd']",
      "input[autocomplete='current-password']",
      "input[name='password']",
      "input[id*='password' i]",
    ].some((selector) => {
      const node = document.querySelector(selector);
      return node && isVisible(node) && !node.hasAttribute('disabled');
    });

    const otpVisible = (() => {
      const direct = document.querySelector(
        "input[autocomplete='one-time-code'], input[name='idvPin'], input[name='totpPin'], input[type='tel'], input[name*='code' i], input[name*='pin' i], input[id*='code' i], input[id*='pin' i]",
      );
      if (direct && isVisible(direct) && !direct.hasAttribute('disabled')) return true;
      const segmented = Array.from(document.querySelectorAll("input[inputmode='numeric'], input[pattern='[0-9]*']")).filter((node) => isVisible(node));
      return segmented.length >= 4;
    })();

    const manualActionReason =
      /just a moment|verify you are human|captcha|unusual activity|passkey|security key|qr code|scan this qr|tap yes on your phone|choose how you want to sign in|confirm it'?s you/i.test(String(title) + ' ' + String(bodyText))
        ? 'cloudflare_or_captcha'
        : null;

    const googleVerificationCopy =
      /google account recovery|verify it'?s you|verify it'?s really you|enter the code|enter a code|get a verification code|verification code|check your phone|two-step verification|2-step verification/i.test(
        String(title) + ' ' + String(bodyText),
      );

    const errorText = (() => {
      const candidates = Array.from(
        document.querySelectorAll('[role="alert"], [aria-live="assertive"], [aria-live="polite"]'),
      )
        .map((node) => normalize(node.textContent || ''))
        .filter(Boolean);
      const firstCandidate = candidates.find((candidate) =>
        /couldn'?t find your google account|enter a valid email|wrong password|incorrect password|try again|something went wrong|invalid code|incorrect code|wrong code|code is invalid|expired code/i.test(candidate),
      );
      if (firstCandidate) return firstCandidate;
      const bodyMatch = bodyText.match(
        /Couldn’t find your Google Account|Couldn't find your Google Account|Enter a valid email or phone|Wrong password|Incorrect password|Invalid code|Incorrect code|Wrong code|Code is invalid|Expired code/i,
      );
      return bodyMatch ? bodyMatch[0] : null;
    })();

    const provider =
      isGoogleAuthHost
        ? 'google'
        : isOpenAiAuthHost
          ? 'openai'
          : isChatgptHost
            ? 'chatgpt'
            : 'unknown';

    let phase = 'unknown';
    if (manualActionReason) {
      phase = 'manual_action_required';
    } else if (otpVisible || googleVerificationCopy || /verification code|one-time code|enter code|check your email/i.test(bodyText)) {
      phase = 'otp';
    } else if (passwordVisible) {
      phase = 'password';
    } else if (identifierVisible) {
      phase = 'identifier';
    } else if (isChatgptHost && (promptReady || meHasSession)) {
      phase = 'logged_in';
    } else if (accountPickerLabels.length > 0) {
      phase = 'account_picker';
    } else if (loginCtaLabel) {
      phase = 'login_cta';
    } else if (promptReady || meHasSession) {
      phase = 'logged_in';
    }

    return {
      phase,
      provider,
      href,
      title,
      readyState,
      statusCode,
      loginCtaLabel,
      primaryButtonLabel,
      accountPickerLabels,
      bodyPreview: bodyText.slice(0, 600),
      identifierVisible,
      passwordVisible,
      otpVisible,
      manualActionReason,
      errorText,
    };
  })()`;
}

function normalizeAuthPageState(raw: unknown): ChatgptAuthPageState {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const phase = normalizeLoginPhase(value.phase);
  return {
    phase,
    provider:
      value.provider === "chatgpt" || value.provider === "openai" || value.provider === "google"
        ? value.provider
        : "unknown",
    href: typeof value.href === "string" ? value.href : "",
    title: typeof value.title === "string" ? value.title : "",
    readyState: typeof value.readyState === "string" ? value.readyState : "",
    statusCode: typeof value.statusCode === "number" ? value.statusCode : undefined,
    loginCtaLabel: typeof value.loginCtaLabel === "string" ? value.loginCtaLabel : null,
    primaryButtonLabel:
      typeof value.primaryButtonLabel === "string" ? value.primaryButtonLabel : null,
    accountPickerLabels: Array.isArray(value.accountPickerLabels)
      ? value.accountPickerLabels.filter((item): item is string => typeof item === "string")
      : [],
    bodyPreview: typeof value.bodyPreview === "string" ? value.bodyPreview : "",
    identifierVisible: Boolean(value.identifierVisible),
    passwordVisible: Boolean(value.passwordVisible),
    otpVisible: Boolean(value.otpVisible),
    manualActionReason:
      typeof value.manualActionReason === "string" ? value.manualActionReason : null,
    errorText: typeof value.errorText === "string" ? value.errorText : null,
  };
}

function normalizeLoginPhase(value: unknown): ChatgptLoginPhase {
  switch (value) {
    case "logged_in":
    case "login_cta":
    case "account_picker":
    case "identifier":
    case "password":
    case "otp":
    case "manual_action_required":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

async function saveChatgptLoginContinuation(value: SavedChatgptLoginContinuation): Promise<string> {
  const statePath = resolveChatgptLoginStatePath();
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return value.id;
}

async function loadSavedChatgptLoginContinuation(): Promise<SavedChatgptLoginContinuation | null> {
  try {
    const raw = await fs.readFile(resolveChatgptLoginStatePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<SavedChatgptLoginContinuation>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (typeof parsed.host !== "string" || typeof parsed.port !== "number") {
      return null;
    }
    return {
      id: typeof parsed.id === "string" ? parsed.id : crypto.randomUUID(),
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      host: parsed.host,
      port: parsed.port,
      targetId: typeof parsed.targetId === "string" ? parsed.targetId : undefined,
      profileDir: typeof parsed.profileDir === "string" ? parsed.profileDir : null,
      browserPid: typeof parsed.browserPid === "number" ? parsed.browserPid : undefined,
      pageHref: typeof parsed.pageHref === "string" ? parsed.pageHref : undefined,
    };
  } catch {
    return null;
  }
}

async function clearSavedChatgptLoginContinuation(): Promise<void> {
  await fs.rm(resolveChatgptLoginStatePath(), { force: true }).catch(() => undefined);
}

function resolveChatgptLoginStatePath(): string {
  return path.join(getOracleHomeDir(), "chatgpt-login-state.json");
}

export const __test__ = {
  normalizeAuthPageState,
  normalizeLoginPhase,
  resolveChatgptLoginStatePath,
  isWindowsChromePath,
  sanitizeProfileLabel,
  isWindowsMountedPath,
  shouldUseWindowsLocalProfileDir,
  resolveLocalLoginProfileDir,
};
