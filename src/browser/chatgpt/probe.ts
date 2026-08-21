import { createHash } from "node:crypto";
import { connectToRemoteChrome, closeRemoteChromeTarget } from "../chromeLifecycle.js";
import { resolveBrowserConfig } from "../config.js";
import { CHATGPT_URL } from "../constants.js";
import { navigateToChatGPT } from "../actions/navigation.js";
import { delay } from "../utils.js";
import type { BrowserAutomationConfig, BrowserLogger, ChromeClient } from "../types.js";
import type {
  ChatgptCapabilityChallenge,
  ChatgptCapabilityFailureCode,
  ChatgptCapabilityLoginState,
  ChatgptCapabilityPageIdentity,
  ChatgptCapabilityProbeResult,
  ChatgptCapabilityProbeStatus,
} from "./types.js";

export const CHATGPT_CAPABILITY_ADAPTER_VERSION = "chatgpt-web-v1";

export interface ChatgptCapabilityProbeOptions {
  config?: BrowserAutomationConfig;
  timeoutMs?: number;
  keepTab?: boolean;
  log?: BrowserLogger;
}

interface CapabilityProbeObservation {
  page?: {
    identityClass?: unknown;
    readyState?: unknown;
    locale?: unknown;
  };
  auth?: {
    state?: unknown;
    challenge?: unknown;
  };
  controls?: {
    modes?: unknown;
    models?: unknown;
    effort?: unknown;
    uploads?: {
      file?: unknown;
      image?: unknown;
      multiple?: unknown;
    };
  };
  indicators?: {
    project?: unknown;
    projectSources?: unknown;
    work?: unknown;
    research?: unknown;
    tools?: unknown;
  };
  structure?: {
    readyState?: unknown;
    landmarkCount?: unknown;
    buttonCount?: unknown;
    inputCount?: unknown;
    linkCount?: unknown;
    dialogCount?: unknown;
    menuCount?: unknown;
  };
}

const EMPTY_STRUCTURE = {
  readyState: "unknown",
  landmarkCount: 0,
  buttonCount: 0,
  inputCount: 0,
  linkCount: 0,
  dialogCount: 0,
  menuCount: 0,
};

const SAFE_MODES = new Set(["chat", "work", "search", "deep-research", "images"]);
const SAFE_MODELS = new Set([
  "gpt-5.6",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-4o",
  "gemini",
  "claude",
  "o-series",
]);
const SAFE_EFFORT = new Set([
  "light",
  "standard",
  "medium",
  "high",
  "extra-high",
  "extended",
  "heavy",
  "pro",
]);
const SAFE_TOOLS = new Set([
  "tools",
  "apps",
  "connectors",
  "search",
  "canvas",
  "code",
  "browser",
  "image-generation",
]);

export async function readChatgptCapabilityProbe(
  options: ChatgptCapabilityProbeOptions = {},
): Promise<ChatgptCapabilityProbeResult> {
  const logger = options.log ?? ((_message: string) => {});
  const capturedAt = new Date().toISOString();
  let config;
  try {
    config = resolveBrowserConfig(options.config);
  } catch {
    return createFailureProbe({ capturedAt, status: "unavailable", code: "configuration_missing" });
  }

  const remoteChrome = config.remoteChrome;
  if (!remoteChrome) {
    return createFailureProbe({ capturedAt, status: "unavailable", code: "configuration_missing" });
  }

  let connection;
  try {
    connection = await connectToRemoteChrome(
      remoteChrome.host,
      remoteChrome.port,
      logger,
      config.chatgptUrl ?? config.url ?? CHATGPT_URL,
      undefined,
      { maxTabs: config.remoteChromeMaxTabs },
    );
  } catch {
    return createFailureProbe({
      capturedAt,
      status: "unavailable",
      code: "connection_failed",
      remoteChrome,
    });
  }

  const client = connection.client;
  try {
    const { Page, Runtime } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    try {
      await navigateToChatGPT(
        Page,
        Runtime,
        config.chatgptUrl ?? config.url ?? CHATGPT_URL,
        logger,
      );
    } catch (error) {
      const stage = readBrowserErrorStage(error);
      if (stage === "cloudflare-challenge") {
        return createChallengeProbe({ capturedAt, remoteChrome, challenge: "cloudflare" });
      }
      if (stage === "account-security" || stage === "chatgpt-account-blocked") {
        return createChallengeProbe({ capturedAt, remoteChrome, challenge: "account_security" });
      }
      return createFailureProbe({
        capturedAt,
        status: "unavailable",
        code: "navigation_failed",
        remoteChrome,
      });
    }

    const probeDeadline = Date.now() + Math.min(options.timeoutMs ?? 20_000, 30_000);
    await waitForDocumentReady(Runtime, probeDeadline);
    return await evaluateCapabilityProbeUntilSettled(
      Runtime,
      capturedAt,
      remoteChrome,
      probeDeadline,
    );
  } catch {
    return createFailureProbe({
      capturedAt,
      status: "unavailable",
      code: "evaluation_failed",
      remoteChrome,
    });
  } finally {
    try {
      await client.close();
    } catch {
      // Probe cleanup is best-effort and must not turn a typed result into an exception.
    }
    if (!options.keepTab) {
      await closeRemoteChromeTarget(
        remoteChrome.host,
        remoteChrome.port,
        connection.targetId,
        logger,
      ).catch(() => undefined);
    }
  }
}

export function buildCapabilityProbeExpressionForTest(): string {
  return buildCapabilityProbeExpression();
}

export function normalizeCapabilityProbeObservationForTest(
  value: unknown,
  capturedAt = "2026-01-01T00:00:00.000Z",
  remoteChrome: { host: string; port: number } | null = null,
): ChatgptCapabilityProbeResult {
  return normalizeCapabilityProbeObservation(value, capturedAt, remoteChrome);
}

export async function settleCapabilityProbeObservationsForTest(
  observations: [CapabilityProbeObservation, ...CapabilityProbeObservation[]],
): Promise<ChatgptCapabilityProbeResult> {
  let index = 0;
  return await pollCapabilityProbeObservation(
    async () => observations[Math.min(index++, observations.length - 1)],
    "2026-08-10T12:00:00.000Z",
    { host: "127.0.0.1", port: 9222 },
    Date.now() + 1_000,
    async () => {},
  );
}

async function evaluateCapabilityProbe(
  Runtime: ChromeClient["Runtime"],
): Promise<CapabilityProbeObservation> {
  const outcome = await Runtime.evaluate({
    expression: buildCapabilityProbeExpression(),
    returnByValue: true,
  });
  return outcome?.result?.value as CapabilityProbeObservation;
}

async function evaluateCapabilityProbeUntilSettled(
  Runtime: ChromeClient["Runtime"],
  capturedAt: string,
  remoteChrome: { host: string; port: number },
  deadline: number,
): Promise<ChatgptCapabilityProbeResult> {
  return await pollCapabilityProbeObservation(
    async () => await evaluateCapabilityProbe(Runtime),
    capturedAt,
    remoteChrome,
    deadline,
    delay,
  );
}

async function pollCapabilityProbeObservation(
  evaluate: () => Promise<CapabilityProbeObservation>,
  capturedAt: string,
  remoteChrome: { host: string; port: number },
  deadline: number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<ChatgptCapabilityProbeResult> {
  while (true) {
    const result = normalizeCapabilityProbeObservation(await evaluate(), capturedAt, remoteChrome);
    if (result.status !== "unknown" || Date.now() >= deadline) return result;
    await wait(Math.min(250, Math.max(0, deadline - Date.now())));
  }
}

function buildCapabilityProbeExpression(): string {
  return `(() => {
    const visible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const labelFor = (node) => normalize(
      node.getAttribute?.('aria-label') || node.getAttribute?.('title') || node.textContent || '',
    );
    const testIdFor = (node) => normalize(
      node.getAttribute?.('data-testid') || node.getAttribute?.('data-test-id') || node.id || '',
    );
    const controls = Array.from(document.querySelectorAll(
      'button,[role="button"],[role="radio"],[role="option"],[role="menuitem"],[role="tab"],input[type="file"],[aria-label],[data-testid]'
    )).filter(visible);
    const labels = controls.map(labelFor);
    const signals = controls.map((node) => labelFor(node) + ' ' + testIdFor(node)).join(' ');
    const has = (pattern) => pattern.test(signals);
    const add = (set, value) => { if (value && !set.includes(value)) set.push(value); };
    const modes = [];
    const models = [];
    const effort = [];
    const tools = [];
    for (const label of labels) {
      if (/deep\\s*research|research/.test(label)) add(modes, 'deep-research');
      else if (/\\bwork\\b|agent/.test(label)) add(modes, 'work');
      else if (/\\bsearch\\b/.test(label)) add(modes, 'search');
      else if (/image|dall|create\\s+images?/.test(label)) add(modes, 'images');
      else if (/\\bchat\\b/.test(label)) add(modes, 'chat');
      if (/gpt[ -]?(?:5[.]?6|56)/.test(label)) add(models, 'gpt-5.6');
      else if (/gpt[ -]?(?:5[.]?5|55)/.test(label)) add(models, 'gpt-5.5');
      else if (/gpt[ -]?(?:5[.]?4|54)/.test(label)) add(models, 'gpt-5.4');
      else if (/gpt[ -]?(?:5[.]?2|52)/.test(label)) add(models, 'gpt-5.2');
      else if (/gpt[ -]?(?:5[.]?1|51)/.test(label)) add(models, 'gpt-5.1');
      else if (/gpt[ -]?4o|chatgpt/.test(label)) add(models, 'gpt-4o');
      else if (/gemini/.test(label)) add(models, 'gemini');
      else if (/claude|sonnet|haiku|opus/.test(label)) add(models, 'claude');
      else if (/\\bo[34]\\b/.test(label)) add(models, 'o-series');
      if (/extra[ -]?high|extra[ -]?hoch/.test(label)) add(effort, 'extra-high');
      else if (/\\b(?:extended|erweitert)\\b/.test(label)) add(effort, 'extended');
      else if (/\\bheavy\\b|\\bhoch\\b/.test(label)) add(effort, 'heavy');
      else if (/\\bstandard\\b|\\bmittel\\b/.test(label)) add(effort, 'standard');
      else if (/\\bmedium\\b/.test(label)) add(effort, 'medium');
      else if (/\\blight\\b|\\bleicht\\b/.test(label)) add(effort, 'light');
      else if (/\\bhigh\\b/.test(label)) add(effort, 'high');
      else if (/\\bpro\\b/.test(label)) add(effort, 'pro');
      if (/connector|\\bapps?\\b/.test(label)) add(tools, 'apps');
      if (/\\btools?\\b/.test(label)) add(tools, 'tools');
      if (/search/.test(label)) add(tools, 'search');
      if (/canvas/.test(label)) add(tools, 'canvas');
      if (/\\bcode\\b|interpreter|analysis/.test(label)) add(tools, 'code');
      if (/\\bbrowser\\b|web\\s*brows/.test(label)) add(tools, 'browser');
      if (/image|dall/.test(label)) add(tools, 'image-generation');
    }
    const pathname = String(location.pathname || '').toLowerCase();
    const bodyText = normalize(document.body?.innerText || '');
    const title = normalize(document.title || '');
    const hasChallengeWidget = Boolean(document.querySelector(
      '#challenge-form,#challenge-running,#cf-challenge-running,[class*="cf-challenge"],iframe[src*="challenges.cloudflare.com"],iframe[src*="/cdn-cgi/challenge-platform/"]'
    ));
    const challenge = hasChallengeWidget || /just a moment|attention required|checking your browser|verify you are human|cloudflare/.test(title + ' ' + bodyText);
    const hasAuthForm = Boolean(document.querySelector(
      'input[type="password"],input[type="email"],input[name="username"],a[href*="/auth/login"],button[data-testid*="login" i]'
    ));
    const authPage = pathname.includes('/auth/') || hasAuthForm || /sign in|log in|login required/.test(bodyText);
    const hasComposer = Boolean(document.querySelector(
      '#prompt-textarea,textarea[name="prompt-textarea"],[contenteditable="true"][data-lexical-editor="true"],[contenteditable="true"][role="textbox"]'
    ));
    const hasAppShell = hasComposer || Boolean(document.querySelector(
      'main,[data-testid="conversation-turn"],[data-testid*="composer" i],nav'
    ));
    let identityClass = 'other';
    let authState = 'unknown';
    let challengeState = 'none';
    if (challenge) {
      identityClass = 'challenge';
      authState = 'challenge_required';
      challengeState = /cloudflare|just a moment|checking your browser/.test(title + ' ' + bodyText) ? 'cloudflare' : 'unknown';
    } else if (authPage) {
      identityClass = 'auth';
      authState = 'login_required';
    } else if (hasAppShell && /chatgpt\\.com|chat\\.openai\\.com/.test(location.hostname || '')) {
      identityClass = 'chatgpt_app';
      authState = hasComposer ? 'logged_in' : 'unknown';
    }
    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
    const structuralLandmarks = [];
    if (hasComposer) structuralLandmarks.push('composer');
    if (document.querySelector('[data-testid*="model" i],button[id*="model" i]')) structuralLandmarks.push('model-picker');
    if (document.querySelector('[data-testid*="project" i],a[href*="/project"]')) structuralLandmarks.push('project');
    if (/research/.test(signals)) structuralLandmarks.push('research');
    if (/\\bwork\\b|agent/.test(signals)) structuralLandmarks.push('work');
    if (fileInputs.length) structuralLandmarks.push('upload');
    const uploadFile = fileInputs.some((node) => !node.accept || !/image/i.test(node.accept));
    const uploadImage = fileInputs.some((node) => /image/i.test(node.accept || ''));
    return {
      page: {
        identityClass,
        readyState: document.readyState || 'unknown',
        locale: navigator.language || null,
      },
      auth: { state: authState, challenge: challengeState },
      controls: {
        modes,
        models,
        effort,
        uploads: {
          file: uploadFile || has(/upload|attach|file/),
          image: uploadImage || has(/photo|image/),
          multiple: fileInputs.some((node) => node.multiple),
        },
      },
      indicators: {
        project: has(/project|gizmo/),
        projectSources: has(/source|knowledge/),
        work: modes.includes('work') || has(/\\bwork\\b|agent/),
        research: modes.includes('deep-research') || has(/deep\\s*research|research/),
        tools,
      },
      structure: {
        readyState: document.readyState || 'unknown',
        landmarkCount: structuralLandmarks.length,
        buttonCount: document.querySelectorAll('button,[role="button"]').length,
        inputCount: document.querySelectorAll('input,textarea,[contenteditable="true"]').length,
        linkCount: document.querySelectorAll('a').length,
        dialogCount: document.querySelectorAll('[role="dialog"],dialog').length,
        menuCount: document.querySelectorAll('[role="menu"],[role="listbox"]').length,
      },
    };
  })()`;
}

function normalizeCapabilityProbeObservation(
  value: unknown,
  capturedAt: string,
  remoteChrome: { host: string; port: number } | null,
): ChatgptCapabilityProbeResult {
  const record = value && typeof value === "object" ? (value as CapabilityProbeObservation) : null;
  if (!record) {
    return createFailureProbe({
      capturedAt,
      status: "unknown",
      code: "invalid_observation",
      remoteChrome,
    });
  }
  const identityClass = normalizeIdentityClass(record.page?.identityClass);
  const authState = normalizeLoginState(record.auth?.state);
  const challenge = normalizeChallenge(record.auth?.challenge);
  const status = statusFromObservation(identityClass, authState, challenge);
  const structure = normalizeStructure(record.structure);
  return {
    schemaVersion: 1,
    status,
    capturedAt,
    adapterVersion: CHATGPT_CAPABILITY_ADAPTER_VERSION,
    remoteChrome,
    page: {
      identityClass,
      readyState: normalizeReadyState(record.page?.readyState),
      locale: normalizeLocale(record.page?.locale),
    },
    auth: { state: authState, challenge },
    controls: {
      modes: normalizeSafeList(record.controls?.modes, SAFE_MODES),
      models: normalizeSafeList(record.controls?.models, SAFE_MODELS),
      effort: normalizeSafeList(record.controls?.effort, SAFE_EFFORT),
      uploads: {
        file: Boolean(record.controls?.uploads?.file),
        image: Boolean(record.controls?.uploads?.image),
        multiple: Boolean(record.controls?.uploads?.multiple),
      },
    },
    indicators: {
      project: Boolean(record.indicators?.project),
      projectSources: Boolean(record.indicators?.projectSources),
      work: Boolean(record.indicators?.work),
      research: Boolean(record.indicators?.research),
      tools: normalizeSafeList(record.indicators?.tools, SAFE_TOOLS),
    },
    fingerprint: {
      algorithm: "sha256",
      hash: hashStructure(structure),
      structure,
    },
  };
}

function createFailureProbe(options: {
  capturedAt: string;
  status: ChatgptCapabilityProbeStatus;
  code: ChatgptCapabilityFailureCode;
  remoteChrome?: { host: string; port: number } | null;
}): ChatgptCapabilityProbeResult {
  const structure = { ...EMPTY_STRUCTURE };
  return {
    schemaVersion: 1,
    status: options.status,
    capturedAt: options.capturedAt,
    adapterVersion: CHATGPT_CAPABILITY_ADAPTER_VERSION,
    remoteChrome: options.remoteChrome ?? null,
    page: { identityClass: "unknown", readyState: "unknown", locale: null },
    auth: { state: "unknown", challenge: "unknown" },
    controls: {
      modes: [],
      models: [],
      effort: [],
      uploads: { file: false, image: false, multiple: false },
    },
    indicators: { project: false, projectSources: false, work: false, research: false, tools: [] },
    fingerprint: { algorithm: "sha256", hash: hashStructure(structure), structure },
    failure: { code: options.code },
  };
}

function createChallengeProbe(options: {
  capturedAt: string;
  remoteChrome: { host: string; port: number };
  challenge: Exclude<ChatgptCapabilityChallenge, "none" | "unknown">;
}): ChatgptCapabilityProbeResult {
  const result = createFailureProbe({
    capturedAt: options.capturedAt,
    status: "challenge_required",
    code: "navigation_failed",
    remoteChrome: options.remoteChrome,
  });
  result.page.identityClass = "challenge";
  result.auth.state = "challenge_required";
  result.auth.challenge = options.challenge;
  delete result.failure;
  return result;
}

function statusFromObservation(
  identityClass: ChatgptCapabilityPageIdentity,
  authState: ChatgptCapabilityLoginState,
  challenge: ChatgptCapabilityChallenge,
): ChatgptCapabilityProbeStatus {
  if (challenge !== "none") return "challenge_required";
  if (authState === "login_required") return "login_required";
  if (identityClass === "chatgpt_app" && authState === "logged_in") return "ok";
  return "unknown";
}

function normalizeIdentityClass(value: unknown): ChatgptCapabilityPageIdentity {
  return value === "chatgpt_app" || value === "auth" || value === "challenge" || value === "other"
    ? value
    : "unknown";
}

function normalizeLoginState(value: unknown): ChatgptCapabilityLoginState {
  return value === "logged_in" || value === "login_required" || value === "challenge_required"
    ? value
    : "unknown";
}

function normalizeChallenge(value: unknown): ChatgptCapabilityChallenge {
  return value === "none" ||
    value === "cloudflare" ||
    value === "account_security" ||
    value === "unknown"
    ? value
    : "unknown";
}

function normalizeReadyState(value: unknown): "loading" | "interactive" | "complete" | "unknown" {
  return value === "loading" || value === "interactive" || value === "complete" ? value : "unknown";
}

function normalizeLocale(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const locale = value.trim();
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale) ? locale : null;
}

function normalizeSafeList(value: unknown, allowed: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && allowed.has(item) && !result.includes(item)) result.push(item);
  }
  return result;
}

function normalizeStructure(
  value: CapabilityProbeObservation["structure"],
): ChatgptCapabilityProbeResult["fingerprint"]["structure"] {
  const number = (candidate: unknown) =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? Math.max(0, Math.min(100_000, Math.floor(candidate)))
      : 0;
  return {
    readyState: normalizeReadyState(value?.readyState),
    landmarkCount: number(value?.landmarkCount),
    buttonCount: number(value?.buttonCount),
    inputCount: number(value?.inputCount),
    linkCount: number(value?.linkCount),
    dialogCount: number(value?.dialogCount),
    menuCount: number(value?.menuCount),
  };
}

function hashStructure(
  structure: ChatgptCapabilityProbeResult["fingerprint"]["structure"],
): string {
  return createHash("sha256").update(JSON.stringify(structure)).digest("hex");
}

function readBrowserErrorStage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  const stage = (details as { stage?: unknown }).stage;
  return typeof stage === "string" ? stage : undefined;
}

async function waitForDocumentReady(
  Runtime: ChromeClient["Runtime"],
  deadline: number,
): Promise<void> {
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: "document.readyState",
      returnByValue: true,
    });
    if (result?.value === "interactive" || result?.value === "complete") return;
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  }
}
