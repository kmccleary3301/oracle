import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserLogger, ChromeClient } from "../types.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import { submitPrompt } from "../actions/promptComposer.js";
import { activateDeepResearch, waitForDeepResearchCompletion } from "../actions/deepResearch.js";
import { extractChatgptResponseOutput } from "../actions/responseOutput.js";
import { delay } from "../utils.js";
import {
  ApprovalGrantAuthority,
  bindApprovalChallenge,
  createApprovalChallenge,
  type ApprovalChallenge,
} from "../approvalToken.js";
import {
  RESEARCH_STATES,
  type ResearchAnswer,
  type ResearchErrorClassification,
  type ResearchPlanSnapshot,
  type ResearchProgress,
  type ResearchReportArtifact,
  type ResearchResult,
  type ResearchSnapshot,
  type ResearchSourceAllowlist,
  type ResearchState,
} from "./researchTypes.js";
export * from "./researchTypes.js";
export const RESEARCH_APPROVAL_ACTION = "approve" as const;
export const RESEARCH_MODE_LABEL = "Deep research" as const;

interface RawResearchSnapshot {
  url?: unknown;
  href?: unknown;
  conversationId?: unknown;
  mode?: unknown;
  state?: unknown;
  status?: unknown;
  controls?: {
    deepResearch?: unknown;
    research?: unknown;
    deepResearchSelected?: unknown;
    researchSelected?: unknown;
    stop?: unknown;
    plan?: unknown;
  };
  active?: unknown;
  activeTurnId?: unknown;
  turn?: { id?: unknown; revisionHash?: unknown; active?: unknown } | null;
  progress?: { phase?: unknown; label?: unknown; percent?: unknown; state?: unknown } | null;
  plan?: {
    revisionHash?: unknown;
    revision?: unknown;
    summary?: unknown;
    action?: unknown;
    sites?: unknown;
    sources?: unknown;
    apps?: unknown;
    consequential?: unknown;
    externalWrite?: unknown;
    unknown?: unknown;
    approvePoint?: { x?: unknown; y?: unknown } | null;
    editPoint?: { x?: unknown; y?: unknown } | null;
  } | null;
  userQuestion?: {
    id?: unknown;
    question?: unknown;
    answerPoint?: { x?: unknown; y?: unknown } | null;
  } | null;
  question?: unknown;
}
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function asStringList(value: unknown): string[] {
  return !Array.isArray(value)
    ? []
    : Array.from(
        new Set(
          value
            .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
            .map((item) => item.trim()),
        ),
      );
}
function point(
  value: { x?: unknown; y?: unknown } | null | undefined,
): { x: number; y: number } | null {
  return typeof value?.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y)
    ? { x: value.x, y: value.y }
    : null;
}
function normalizeState(value: unknown): ResearchState | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[ -]+/g, "_");
  return (RESEARCH_STATES as readonly string[]).includes(normalized)
    ? (normalized as ResearchState)
    : null;
}
export function extractResearchConversationId(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).pathname.match(/^\/c\/([A-Za-z0-9-]+)(?:\/|$)/)?.[1] ?? null;
  } catch {
    return value.match(/\/c\/([A-Za-z0-9-]+)(?:\/|$)/)?.[1] ?? null;
  }
}
function canonicalPlanMaterial(plan: Omit<ResearchPlanSnapshot, "revisionHash">): string {
  return JSON.stringify({
    action: plan.action ?? null,
    apps: [...plan.apps].sort(),
    consequential: Boolean(plan.consequential),
    externalWrite: Boolean(plan.externalWrite),
    sites: [...plan.sites].sort(),
    summary: plan.summary ?? null,
    unknown: Boolean(plan.unknown),
  });
}
export function hashResearchPlan(plan: Omit<ResearchPlanSnapshot, "revisionHash">): string {
  return createHash("sha256").update(canonicalPlanMaterial(plan), "utf8").digest("hex");
}
function inferState(
  raw: RawResearchSnapshot,
  mode: ResearchSnapshot["mode"],
  plan: ResearchPlanSnapshot | null,
): ResearchState {
  const explicit = normalizeState(raw.state ?? raw.status);
  if (explicit) return explicit;
  if (mode !== "deep-research") return "unsupported";
  if (raw.userQuestion || raw.question) return "waiting_for_user_input";
  if (plan?.unknown) return "requires_action";
  if (raw.active === false || raw.turn?.active === false) return "completed";
  if (raw.active || raw.turn?.active || raw.controls?.stop) return "running";
  if (plan?.revisionHash) return "waiting_for_plan_approval";
  return "submitted";
}
export function classifyResearchSnapshot(
  rawValue: unknown,
  expectedConversationId?: string | null,
): ResearchSnapshot {
  const raw = (rawValue && typeof rawValue === "object" ? rawValue : {}) as RawResearchSnapshot;
  const url = asString(raw.url ?? raw.href) ?? "";
  const conversationId = asString(raw.conversationId) ?? extractResearchConversationId(url);
  const controls = {
    deepResearch: Boolean(raw.controls?.deepResearch ?? raw.controls?.research),
    deepResearchSelected: Boolean(
      raw.controls?.deepResearchSelected ?? raw.controls?.researchSelected,
    ),
    stop: Boolean(raw.controls?.stop ?? raw.active ?? raw.turn?.active),
    plan: Boolean(raw.controls?.plan ?? raw.plan),
  };
  const modeValue = asString(raw.mode)?.toLowerCase();
  const mode: ResearchSnapshot["mode"] =
    controls.deepResearchSelected ||
    modeValue === "deep-research" ||
    modeValue === "deep research" ||
    modeValue === "research"
      ? "deep-research"
      : modeValue === "chat"
        ? "chat"
        : "unknown";
  const rawPlan = raw.plan;
  const plan = rawPlan
    ? (() => {
        const sites = asStringList(rawPlan.sites ?? rawPlan.sources);
        const apps = asStringList(rawPlan.apps);
        const base = {
          summary: asString(rawPlan.summary),
          action: asString(rawPlan.action),
          sites,
          apps,
          consequential: Boolean(rawPlan.consequential),
          externalWrite: Boolean(rawPlan.externalWrite),
          unknown: Boolean(rawPlan.unknown) || !asString(rawPlan.action),
          approvePoint: point(rawPlan.approvePoint),
          editPoint: point(rawPlan.editPoint),
        } satisfies Omit<ResearchPlanSnapshot, "revisionHash">;
        return {
          ...base,
          revisionHash:
            asString(rawPlan.revisionHash ?? rawPlan.revision) ?? hashResearchPlan(base),
        };
      })()
    : null;
  const questionRaw = raw.userQuestion ?? (raw.question ? { question: raw.question } : null);
  const userQuestion = questionRaw
    ? {
        id: asString(questionRaw.id),
        question: asString(questionRaw.question),
        answerPoint: point(questionRaw.answerPoint),
      }
    : null;
  const rawProgress = raw.progress;
  const progress: ResearchProgress | null = rawProgress
    ? {
        state: normalizeState(rawProgress.state) ?? "running",
        phase: asString(rawProgress.phase),
        label: asString(rawProgress.label),
        percent:
          typeof rawProgress.percent === "number" && Number.isFinite(rawProgress.percent)
            ? Math.max(0, Math.min(100, rawProgress.percent))
            : null,
        elapsedMs: null,
        updatedAt: new Date().toISOString(),
      }
    : null;
  const turn =
    raw.turn || raw.activeTurnId || raw.active !== undefined
      ? {
          id: asString(raw.turn?.id ?? raw.activeTurnId),
          revisionHash: asString(raw.turn?.revisionHash),
          active: Boolean(raw.turn?.active ?? raw.active ?? raw.controls?.stop),
        }
      : null;
  const identityConflict =
    expectedConversationId !== undefined && conversationId !== expectedConversationId;
  return {
    url,
    conversationId,
    mode,
    controls,
    state: identityConflict ? "conflict" : inferState(raw, mode, plan),
    turn,
    plan,
    userQuestion,
    progress,
    reason: identityConflict ? "conversation-mismatch" : undefined,
  };
}

/** Fixed selectors only; user source labels are JSON values, never selectors. */
export function buildResearchSnapshotExpression(): string {
  return `(() => {
    const normalize = (value) => String(value ?? '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const visible = (node) => { if (!node || typeof node.getBoundingClientRect !== 'function') return false; const rect = node.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return false; const style = window.getComputedStyle(node); return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'; };
    const selected = (node) => node?.getAttribute?.('aria-checked') === 'true' || node?.getAttribute?.('data-state') === 'on';
    const idMatch = String(location?.pathname || '').match(/^\\/c\\/([A-Za-z0-9-]+)(?:\\/|$)/); const conversationId = idMatch?.[1] || null;
    const deep = document.querySelector('[data-testid="deep-research-mode"], [data-testid="deep-research"], [aria-label="Deep research"]'); const inlineDeep = document.querySelector('[data-inline-selection-pill][data-id="plugin:connector_openai_deep_research"]'); const pill = inlineDeep || document.querySelector('[class*="composer-pill"], [data-testid="composer-pill"]');
    const stop = document.querySelector('[data-testid="stop-button"], [data-testid="deep-research-stop"], [aria-label="Stop research"], [aria-label="Stop"]'); const planNode = document.querySelector('[data-testid="deep-research-plan"], [data-testid="research-plan"], [data-testid="research-plan-card"]'); const statusNode = document.querySelector('[data-testid="deep-research-status"], [role="status"], [aria-live="polite"]'); const questionNode = document.querySelector('[data-testid="deep-research-question"], [data-testid="research-user-question"], [data-testid="user-question"]');
    const pointOf = (node) => { if (!node || !visible(node)) return null; const rect = node.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }; const text = (node) => normalize(node?.textContent); const planText = text(planNode); const planRevision = planNode?.getAttribute?.('data-plan-revision') || planNode?.getAttribute?.('data-revision-hash') || null; const action = planNode?.getAttribute?.('data-action') || null;
    const sites = Array.from(planNode?.querySelectorAll?.('[data-source-site], [data-testid="research-site"]') || []).map((node) => text(node)).filter(Boolean); const apps = Array.from(planNode?.querySelectorAll?.('[data-source-app], [data-testid="research-app"]') || []).map((node) => text(node)).filter(Boolean); const unknown = Boolean(planNode && (!planRevision || !action)); const consequential = Boolean(planNode?.getAttribute?.('data-consequential') === 'true' || /write|delete|send|purchase|publish|external/.test(planText));
    return { url: String(location?.href || ''), conversationId, mode: inlineDeep || deep && selected(deep) || (pill && /deep research/.test(text(pill))) ? 'deep-research' : 'unknown', controls: { deepResearch: Boolean(deep || inlineDeep), deepResearchSelected: Boolean(inlineDeep || deep && selected(deep)), stop: Boolean(stop && visible(stop)), plan: Boolean(planNode && visible(planNode)) }, active: Boolean(stop && visible(stop)), turn: { id: statusNode?.getAttribute?.('data-turn-id') || null, active: Boolean(stop && visible(stop)) }, progress: { state: text(statusNode), phase: statusNode?.getAttribute?.('data-phase') || null, label: text(statusNode), percent: Number(statusNode?.getAttribute?.('aria-valuenow')) || null }, plan: planNode ? { revisionHash: planRevision, action, summary: planText || null, sites, apps, consequential, externalWrite: consequential, unknown, approvePoint: pointOf(planNode.querySelector?.('[data-testid="research-approve"], [aria-label="Approve plan"]')), editPoint: pointOf(planNode.querySelector?.('[data-testid="research-edit"], [aria-label="Edit plan"]')) } : null, userQuestion: questionNode ? { id: questionNode.getAttribute?.('data-question-id') || null, question: text(questionNode), answerPoint: pointOf(questionNode.querySelector?.('[data-testid="research-answer"], [aria-label="Answer"]')) } : null };
  })()`;
}
export function buildResearchSnapshotExpressionForTest(): string {
  return buildResearchSnapshotExpression();
}
export async function readResearchSnapshot(
  Runtime: ChromeClient["Runtime"],
  expectedConversationId?: string | null,
): Promise<ResearchSnapshot> {
  const outcome = await Runtime.evaluate({
    expression: buildResearchSnapshotExpression(),
    returnByValue: true,
  });
  return classifyResearchSnapshot(outcome.result?.value, expectedConversationId);
}

export function createResearchApprovalChallenge(
  conversationId: string,
  planRevisionHash: string,
  expiry = Date.now() + 5 * 60 * 1000,
): ApprovalChallenge {
  return createApprovalChallenge({
    operation: RESEARCH_APPROVAL_ACTION,
    target: conversationId,
    revision: planRevisionHash,
    payload: { conversationId },
    expiry,
  });
}

function normalizeAllowlist(allowlist?: ResearchSourceAllowlist): ResearchSourceAllowlist {
  return {
    sites: Array.from(new Set((allowlist?.sites ?? []).map((item) => item.trim()).filter(Boolean))),
    apps: Array.from(new Set((allowlist?.apps ?? []).map((item) => item.trim()).filter(Boolean))),
  };
}
export function buildResearchSourceSelectionExpression(allowlist: ResearchSourceAllowlist): string {
  const sites = JSON.stringify(normalizeAllowlist(allowlist).sites);
  const apps = JSON.stringify(normalizeAllowlist(allowlist).apps);
  return `(() => { const wantedSites = ${sites}; const wantedApps = ${apps}; const norm = (value) => String(value ?? '').toLowerCase().trim(); const text = (node) => norm(node?.textContent || node?.getAttribute?.('aria-label')); const visible = (node) => { if (!node || !node.getBoundingClientRect) return false; const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; }; const panel = document.querySelector('[data-testid="deep-research-sources"], [data-testid="research-sources"], [role="dialog"]'); if (!panel) return { status: 'source-control-unavailable', selectedSites: [], selectedApps: [] }; const rows = Array.from(panel.querySelectorAll('[role="option"], [role="checkbox"], [data-testid="research-source"], [data-testid="research-site"], [data-testid="research-app"]')).filter(visible); const selectedSites = []; const selectedApps = []; const unknown = []; for (const row of rows) { const label = text(row); const isApp = row.matches?.('[data-testid="research-app"]') || /connector|app|drive|slack|notion|sharepoint/.test(label); const wanted = (isApp ? wantedApps : wantedSites).some((value) => norm(value) === label); if (wanted) { if (row.getAttribute('aria-checked') !== 'true' && row.getAttribute('data-state') !== 'on') row.click(); (isApp ? selectedApps : selectedSites).push(label); } } for (const value of [...wantedSites, ...wantedApps]) if (![...selectedSites, ...selectedApps].includes(norm(value))) unknown.push(value); return unknown.length ? { status: 'source-restriction', selectedSites, selectedApps, unknown } : { status: 'selected', selectedSites, selectedApps }; })()`;
}
export async function selectResearchSources(
  Runtime: ChromeClient["Runtime"],
  allowlist: ResearchSourceAllowlist,
): Promise<{
  status: "selected" | "source-restriction" | "source-control-unavailable";
  selectedSites: string[];
  selectedApps: string[];
  unknown?: string[];
}> {
  const normalized = normalizeAllowlist(allowlist);
  if (!(normalized.sites?.length || normalized.apps?.length))
    return { status: "selected", selectedSites: [], selectedApps: [] };
  const outcome = await Runtime.evaluate({
    expression: buildResearchSourceSelectionExpression(normalized),
    returnByValue: true,
  });
  const value = outcome.result?.value as
    | { status?: string; selectedSites?: string[]; selectedApps?: string[]; unknown?: string[] }
    | undefined;
  return {
    status:
      value?.status === "selected" || value?.status === "source-restriction"
        ? value.status
        : "source-control-unavailable",
    selectedSites: asStringList(value?.selectedSites),
    selectedApps: asStringList(value?.selectedApps),
    unknown: asStringList(value?.unknown),
  };
}
export interface ResearchStartOptions {
  Runtime: ChromeClient["Runtime"];
  Input: ChromeClient["Input"];
  prompt: string;
  timeoutMs?: number;
  logger: BrowserLogger;
  conversationId?: string | null;
  sourceAllowlist?: ResearchSourceAllowlist;
}
export async function startResearch(options: ResearchStartOptions): Promise<ResearchResult> {
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 30_000);
  try {
    await activateDeepResearch(options.Runtime, options.Input, options.logger);
    const selected = await selectResearchSources(options.Runtime, options.sourceAllowlist ?? {});
    if (selected.status !== "selected")
      return {
        state: "unsupported",
        conversationUrl: null,
        conversationId: options.conversationId ?? null,
        reason: selected.status,
        recovery: { recoverable: false },
      };
    const before = await readResearchSnapshot(options.Runtime, options.conversationId);
    await submitPrompt(
      { runtime: options.Runtime, input: options.Input, inputTimeoutMs: timeoutMs },
      options.prompt,
      options.logger,
    );
    const after = await readResearchSnapshot(options.Runtime, before.conversationId);
    return {
      state: after.state === "unsupported" ? "submitted" : after.state,
      conversationUrl: after.url || before.url || null,
      conversationId: after.conversationId ?? before.conversationId,
      turnId: after.turn?.id,
      progress: after.progress,
    };
  } catch (error) {
    const classification = classifyResearchError(error);
    return {
      state:
        classification.code === "disconnected"
          ? "disconnected"
          : classification.code === "mode-unavailable"
            ? "unsupported"
            : "requires_action",
      conversationUrl: null,
      conversationId: options.conversationId ?? null,
      reason: classification.code,
      retryAfterMs: classification.retryAfterMs,
      recovery: {
        recoverable: classification.retryable,
        retryAfterMs: classification.retryAfterMs,
        guidance: classification.message,
      },
    };
  }
}

export interface ResearchPlanOptions {
  Runtime: ChromeClient["Runtime"];
  Input?: ChromeClient["Input"];
  prompt?: string;
  conversationId: string;
  dryRun?: boolean;
  approve?: boolean;
  approvalChallenge?: ApprovalChallenge;
  approvalGrant?: string;
  approvalAuthority?: ApprovalGrantAuthority;
  principal?: string;
  session?: string;
  expectedRevisionHash?: string;
  edits?: { summary?: string; action?: string; sites?: string[]; apps?: string[] };
}
export async function planResearch(options: ResearchPlanOptions): Promise<ResearchResult> {
  const snapshot = await readResearchSnapshot(options.Runtime, options.conversationId);
  if (snapshot.state === "conflict") return researchConflict(snapshot, "conversation-mismatch");
  const plan = snapshot.plan;
  const currentHash = plan?.revisionHash ?? null;
  if (options.expectedRevisionHash && options.expectedRevisionHash !== currentHash)
    return researchConflict(snapshot, "plan-revision-conflict");
  const edited = options.edits ? editPlanValue(plan, options.edits) : plan;
  const challenge = edited?.revisionHash
    ? bindApprovalChallenge(
        createResearchApprovalChallenge(options.conversationId, edited.revisionHash),
        options.approvalChallenge,
      )
    : null;
  if (options.dryRun || !options.approve)
    return {
      state: edited?.unknown ? "requires_action" : "waiting_for_plan_approval",
      dryRun: true,
      approvalChallenge: challenge,
      conversationUrl: snapshot.url || null,
      conversationId: snapshot.conversationId,
      plan: edited,
      progress: snapshot.progress,
    };
  if (!options.Input)
    return {
      state: "requires_action",
      dryRun: false,
      approvalChallenge: challenge,
      conversationUrl: snapshot.url || null,
      conversationId: snapshot.conversationId,
      plan: edited,
      reason: "approval-control-unavailable",
    };
  return approveResearchPlan({
    Runtime: options.Runtime,
    Input: options.Input,
    conversationId: options.conversationId,
    approvalChallenge: challenge ?? undefined,
    approvalGrant: options.approvalGrant,
    approvalAuthority: options.approvalAuthority,
    principal: options.principal,
    session: options.session,
    expectedRevisionHash: options.expectedRevisionHash,
  });
}
function editPlanValue(
  plan: ResearchPlanSnapshot | null,
  edits: NonNullable<ResearchPlanOptions["edits"]>,
): ResearchPlanSnapshot | null {
  if (!plan) return null;
  const next = {
    ...plan,
    summary: edits.summary === undefined ? plan.summary : edits.summary.trim() || null,
    action: edits.action === undefined ? plan.action : edits.action.trim() || null,
    sites:
      edits.sites === undefined
        ? plan.sites
        : Array.from(new Set(edits.sites.map((site) => site.trim()).filter(Boolean))),
    apps:
      edits.apps === undefined
        ? plan.apps
        : Array.from(new Set(edits.apps.map((app) => app.trim()).filter(Boolean))),
  };
  return { ...next, revisionHash: hashResearchPlan(next) };
}
function researchConflict(snapshot: ResearchSnapshot, reason: string): ResearchResult {
  return {
    state: "conflict",
    conversationUrl: snapshot.url || null,
    conversationId: snapshot.conversationId,
    plan: snapshot.plan,
    progress: snapshot.progress,
    reason,
  };
}
export async function approveResearchPlan(options: {
  Runtime: ChromeClient["Runtime"];
  Input: ChromeClient["Input"];
  conversationId: string;
  approvalChallenge?: ApprovalChallenge;
  approvalGrant?: string;
  approvalAuthority?: ApprovalGrantAuthority;
  principal?: string;
  session?: string;
  expectedRevisionHash?: string;
}): Promise<ResearchResult> {
  const snapshot = await readResearchSnapshot(options.Runtime, options.conversationId);
  const plan = snapshot.plan;
  const challenge = plan?.revisionHash
    ? bindApprovalChallenge(
        createResearchApprovalChallenge(options.conversationId, plan.revisionHash),
        options.approvalChallenge,
      )
    : null;
  if (snapshot.state === "conflict" || snapshot.conversationId !== options.conversationId)
    return researchConflict(snapshot, "conversation-mismatch");
  if (
    !plan ||
    !plan.revisionHash ||
    (options.expectedRevisionHash && options.expectedRevisionHash !== plan.revisionHash)
  )
    return researchConflict(snapshot, "plan-revision-conflict");
  if (plan.unknown || plan.consequential || plan.externalWrite)
    return {
      state: "requires_action",
      dryRun: false,
      approvalChallenge: challenge,
      conversationUrl: snapshot.url || null,
      conversationId: snapshot.conversationId,
      plan,
      reason: "unknown-or-consequential-plan",
    };
  if (!challenge || !options.approvalAuthority)
    return {
      state: "requires_action",
      dryRun: false,
      approvalChallenge: challenge,
      conversationUrl: snapshot.url || null,
      conversationId: snapshot.conversationId,
      plan,
      reason: "approval-authority-unavailable",
    };
  const consumed = options.approvalAuthority.consumeGrant(options.approvalGrant, challenge, {
    principal: options.principal,
    session: options.session,
  });
  if (consumed.state !== "consumed")
    return {
      state: "requires_action",
      dryRun: false,
      approvalChallenge: challenge,
      conversationUrl: snapshot.url || null,
      conversationId: snapshot.conversationId,
      plan,
      reason: consumed.reason,
    };
  if (!plan.approvePoint)
    return {
      state: "requires_action",
      dryRun: false,
      approvalChallenge: challenge,
      conversationUrl: snapshot.url || null,
      conversationId: snapshot.conversationId,
      plan,
      reason: "approval-control-unavailable",
    };
  await clickTrustedPoint(options.Input, plan.approvePoint);
  const verified = await readResearchSnapshot(options.Runtime, options.conversationId);
  return {
    state: verified.state,
    dryRun: false,
    conversationUrl: verified.url || snapshot.url || null,
    conversationId: verified.conversationId,
    plan: verified.plan ?? plan,
    progress: verified.progress,
  };
}
async function clickTrustedPoint(
  Input: ChromeClient["Input"],
  click: { x: number; y: number },
): Promise<void> {
  await Input.dispatchMouseEvent({ type: "mouseMoved", x: click.x, y: click.y });
  await Input.dispatchMouseEvent({
    type: "mousePressed",
    x: click.x,
    y: click.y,
    button: "left",
    clickCount: 1,
  });
  await Input.dispatchMouseEvent({
    type: "mouseReleased",
    x: click.x,
    y: click.y,
    button: "left",
    clickCount: 1,
  });
}
export async function getResearch(options: {
  Runtime: ChromeClient["Runtime"];
  conversationId: string;
  logger?: BrowserLogger;
  wait?: boolean;
  timeoutMs?: number;
  Page?: ChromeClient["Page"];
  client?: ChromeClient;
}): Promise<ResearchResult> {
  const logger = options.logger ?? (() => {});
  const snapshot = await readResearchSnapshot(options.Runtime, options.conversationId);
  if (
    !options.wait ||
    [
      "completed",
      "waiting_for_user_input",
      "waiting_for_plan_approval",
      "requires_action",
      "unsupported",
      "conflict",
    ].includes(snapshot.state)
  )
    return {
      state: snapshot.state,
      conversationUrl: snapshot.url || null,
      conversationId: snapshot.conversationId,
      turnId: snapshot.turn?.id,
      plan: snapshot.plan,
      progress: snapshot.progress,
      reason: snapshot.reason,
    };
  try {
    const result = await waitForDeepResearchCompletion(
      options.Runtime,
      logger,
      options.timeoutMs ?? 2_400_000,
      undefined,
      options.Page,
      options.client,
    );
    const output = extractChatgptResponseOutput({
      html: result.html,
      turnId: result.meta.turnId,
      messageId: result.meta.messageId,
      conversationUrl: snapshot.url,
      conversationId: snapshot.conversationId,
    });
    const answer: ResearchAnswer = {
      text: result.text,
      markdown: result.text,
      html: output.sanitizedHtml || result.html,
      citations: output.citations,
      codeBlocks: output.codeBlocks,
      tables: output.tables,
      fileRefs: output.fileRefs,
      imageRefs: output.imageRefs,
      provenance: output.provenance,
      turnId: result.meta.turnId,
      messageId: result.meta.messageId,
    };
    return {
      state: "completed",
      conversationUrl: snapshot.url || null,
      conversationId: snapshot.conversationId,
      turnId: result.meta.turnId,
      messageId: result.meta.messageId,
      answer,
      plan: snapshot.plan,
      progress: {
        state: "completed",
        phase: "complete",
        label: "Research completed",
        percent: 100,
        elapsedMs: null,
        updatedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    const classification = classifyResearchError(error);
    return {
      state: classification.code === "disconnected" ? "disconnected" : "requires_action",
      conversationUrl: snapshot.url || null,
      conversationId: snapshot.conversationId,
      plan: snapshot.plan,
      progress: snapshot.progress,
      reason: classification.code,
      retryAfterMs: classification.retryAfterMs,
      recovery: {
        recoverable: classification.retryable,
        retryAfterMs: classification.retryAfterMs,
        guidance: classification.message,
      },
    };
  }
}

export async function interruptResearch(options: {
  Runtime: ChromeClient["Runtime"];
  Input: ChromeClient["Input"];
  conversationId: string;
  turnId?: string | null;
}): Promise<ResearchResult> {
  const before = await readResearchSnapshot(options.Runtime, options.conversationId);
  if (before.state === "conflict" || before.conversationId !== options.conversationId)
    return researchConflict(before, "conversation-mismatch");
  if (options.turnId && before.turn?.id !== options.turnId)
    return researchConflict(before, "turn-mismatch");
  if (!before.turn?.active && !before.controls.stop)
    return {
      state: before.state,
      verified: before.state === "interrupted",
      conversationUrl: before.url || null,
      conversationId: before.conversationId,
      turnId: before.turn?.id,
      reason: "turn-not-active",
    };
  const pointResult = await options.Runtime.evaluate({
    expression: buildResearchInterruptExpression(),
    returnByValue: true,
  });
  const interruptPoint = point(pointResult.result?.value as { x?: unknown; y?: unknown } | null);
  if (!interruptPoint)
    return {
      state: "requires_action",
      verified: false,
      conversationUrl: before.url || null,
      conversationId: before.conversationId,
      turnId: before.turn?.id,
      reason: "interrupt-control-unavailable",
    };
  await clickTrustedPoint(options.Input, interruptPoint);
  const after = await readResearchSnapshot(options.Runtime, options.conversationId);
  const verified = !after.controls.stop && !after.turn?.active;
  return {
    state: verified ? "interrupted" : "requires_action",
    verified,
    conversationUrl: after.url || before.url || null,
    conversationId: after.conversationId,
    turnId: after.turn?.id,
    reason: verified ? undefined : "interrupt-not-verified",
  };
}
export function buildResearchInterruptExpression(): string {
  return `(() => { const visible = (node) => { if (!node || !node.getBoundingClientRect) return false; const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; }; const node = document.querySelector('[data-testid="deep-research-stop"], [data-testid="stop-button"], [aria-label="Stop research"], [aria-label="Stop"]); if (!visible(node)) return null; const rect = node.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`;
}
export async function waitForResearchState(
  Runtime: ChromeClient["Runtime"],
  conversationId: string,
  states: readonly ResearchState[],
  timeoutMs: number,
  pollMs = 200,
): Promise<ResearchSnapshot> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let latest = await readResearchSnapshot(Runtime, conversationId);
  while (!states.includes(latest.state) && Date.now() < deadline) {
    await delay(Math.max(0, pollMs));
    latest = await readResearchSnapshot(Runtime, conversationId);
  }
  return latest;
}
export async function downloadResearchReport(options: {
  reportMarkdown: string;
  outputDir: string;
  formats?: Array<"markdown" | "docx" | "pdf">;
  conversationUrl?: string | null;
  conversationId?: string | null;
  turnId?: string | null;
  messageId?: string | null;
}): Promise<ResearchReportArtifact[]> {
  const formats: Array<"markdown" | "docx" | "pdf"> = Array.from(
    new Set<"markdown" | "docx" | "pdf">(options.formats ?? ["markdown", "docx", "pdf"]),
  );
  const report = options.reportMarkdown.trim();
  if (!report)
    throw new BrowserAutomationError("Research report is empty and cannot be downloaded.", {
      stage: "research-download",
      code: "empty-report",
    });
  await mkdir(options.outputDir, { recursive: true });
  const artifacts: ResearchReportArtifact[] = [];
  for (const format of formats) {
    const bytes =
      format === "markdown"
        ? Buffer.from(`${report}\n`, "utf8")
        : format === "docx"
          ? createMinimalDocx(report)
          : createMinimalPdf(report);
    const extension = format === "markdown" ? "md" : format;
    const filePath = path.join(options.outputDir, `deep-research-report.${extension}`);
    await writeFile(filePath, bytes);
    artifacts.push({
      format,
      downloadedPath: filePath,
      mimeType: mimeTypeForReport(format),
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      conversationUrl: options.conversationUrl,
      conversationId: options.conversationId,
      turnId: options.turnId,
      messageId: options.messageId,
    });
  }
  return artifacts;
}
export async function downloadResearch(options: {
  reportMarkdown: string;
  outputDir: string;
  formats?: Array<"markdown" | "docx" | "pdf">;
  conversationUrl?: string | null;
  conversationId?: string | null;
  turnId?: string | null;
  messageId?: string | null;
}): Promise<ResearchResult> {
  return {
    state: "completed",
    conversationUrl: options.conversationUrl ?? null,
    conversationId: options.conversationId ?? null,
    turnId: options.turnId,
    messageId: options.messageId,
    reports: await downloadResearchReport(options),
  };
}
function mimeTypeForReport(format: "markdown" | "docx" | "pdf"): string {
  return format === "markdown"
    ? "text/markdown"
    : format === "docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/pdf";
}
function createMinimalPdf(text: string): Buffer {
  const escaped = text
    .replace(/[\\()]/g, "\\$&")
    .replace(/\r?\n/g, "\\n")
    .slice(0, 12_000);
  const body = `BT /F1 10 Tf 36 760 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(body, "utf8")} >>\nstream\n${body}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets: number[] = [0];
  objects.forEach((object, index) => {
    offsets[index + 1] = Buffer.byteLength(output, "utf8");
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output, "utf8");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "utf8");
}
function createMinimalDocx(text: string): Buffer {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p></w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  return zipStore([
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", rels],
    ["word/document.xml", xml],
  ]);
}
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
function zipStore(entries: Array<[string, string]>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(value, "utf8");
    const crc = crc32(data);
    const header = Buffer.alloc(30 + nameBytes.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(header, 30);
    local.push(Buffer.concat([header, data]));
    const entry = Buffer.alloc(46 + nameBytes.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    nameBytes.copy(entry, 46);
    central.push(entry);
    offset += header.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const localBytes = Buffer.concat(local);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, end]);
}
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function classifyResearchError(error: unknown): ResearchErrorClassification {
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown research error");
  const lower = message.toLowerCase();
  const details =
    error instanceof BrowserAutomationError
      ? (error.details as { code?: string; retryAfterMs?: number } | undefined)
      : undefined;
  const retryAfterMs =
    typeof details?.retryAfterMs === "number" ? details.retryAfterMs : parseRetryAfterMs(message);
  if (lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("429"))
    return {
      code: "rate-limited",
      retryable: true,
      retryAfterMs,
      message: "Deep Research is rate limited; retry after the supplied delay.",
    };
  if (
    lower.includes("disconnect") ||
    lower.includes("target closed") ||
    lower.includes("websocket") ||
    lower.includes("connection lost")
  )
    return {
      code: "disconnected",
      retryable: true,
      message:
        "The ChatGPT browser connection was lost; recover by reattaching to the same conversation and turn.",
    };
  if (
    details?.code === "dropdown-item-missing" ||
    details?.code === "plus-button-missing" ||
    details?.code === "pill-not-confirmed"
  )
    return {
      code: "mode-unavailable",
      retryable: false,
      message: "Deep Research mode could not be verified in the ChatGPT composer.",
    };
  if (
    lower.includes("source") &&
    (lower.includes("restrict") || lower.includes("allowlist") || lower.includes("control"))
  )
    return {
      code: "source-restriction",
      retryable: false,
      message: "One or more requested Deep Research sources are unavailable or restricted.",
    };
  if (lower.includes("revision") && lower.includes("conflict"))
    return {
      code: "plan-revision-conflict",
      retryable: false,
      message: "The Deep Research plan changed; capture it again before editing or approving.",
    };
  if (lower.includes("grant") && lower.includes("mismatch"))
    return {
      code: "approval-grant-mismatch",
      retryable: false,
      message: "The approval grant does not match the current Deep Research plan.",
    };
  return {
    code: "unknown",
    retryable: false,
    message: "Deep Research failed without exposing sensitive browser details.",
  };
}
function parseRetryAfterMs(message: string): number | undefined {
  const seconds = message.match(/retry[- ]after[^\d]*(\d+(?:\.\d+)?)\s*s/i)?.[1];
  if (seconds) return Math.max(0, Math.ceil(Number(seconds) * 1000));
  const milliseconds = message.match(/retry[- ]after[^\d]*(\d+)\s*ms/i)?.[1];
  return milliseconds ? Math.max(0, Number(milliseconds)) : undefined;
}
export const classifyResearchSnapshotForTest = classifyResearchSnapshot;
export const buildResearchSourceSelectionExpressionForTest = buildResearchSourceSelectionExpression;
export const createMinimalDocxForTest = createMinimalDocx;
export const createMinimalPdfForTest = createMinimalPdf;
