import type { BrowserLogger, ChromeClient } from "../types.js";
import type {
  ProjectConversationRecord,
  ProjectLifecycleDriver,
  ProjectRecord,
  ProjectShareTarget,
  ProjectSnapshot,
  ProjectSourceRecord,
} from "./projectLifecycleTypes.js";
import { delay } from "../utils.js";

interface RuntimeProjectState extends ProjectSnapshot {
  capability: NonNullable<ProjectSnapshot["capability"]>;
}

export interface RuntimeProjectLifecycleDriverOptions {
  Runtime: ChromeClient["Runtime"];
  Input?: ChromeClient["Input"];
  timeoutMs?: number;
  logger?: BrowserLogger;
}

export function createRuntimeProjectLifecycleDriver(
  options: RuntimeProjectLifecycleDriverOptions,
): ProjectLifecycleDriver {
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 20_000);
  const logger = options.logger ?? (() => undefined);
  const read = async (): Promise<RuntimeProjectState> => {
    const result = await options.Runtime.evaluate({
      expression: buildProjectLifecycleStateExpression(),
      returnByValue: true,
    });
    const value = result.result?.value as RuntimeProjectState | undefined;
    if (!value || typeof value !== "object")
      throw new Error("Project lifecycle surface returned no identity.");
    return value;
  };
  const ensureProject = async (projectId: string): Promise<RuntimeProjectState> => {
    const state = await read();
    if (state.projectId !== projectId) throw new Error(`project-id-mismatch:${state.projectId}`);
    if (state.capability.loginState !== "logged_in")
      throw new Error("ChatGPT project page is not logged in.");
    return state;
  };
  const ensureControl = async (kind: "projectControls" | "sourceControls" | "shareControls") => {
    const state = await read();
    if (state.capability.loginState !== "logged_in")
      throw new Error("ChatGPT project page is not logged in.");
    if (state.capability[kind] !== "available") throw new Error(`unsupported:${kind}`);
    return state;
  };
  const mutate = async (expression: string, projectId: string): Promise<RuntimeProjectState> => {
    const outcome = await options.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const value = outcome.result?.value as { ok?: boolean; reason?: string } | undefined;
    if (!value?.ok) throw new Error(value?.reason ?? "unsupported:project-control");
    const deadline = Date.now() + timeoutMs;
    let state = await read();
    while (Date.now() < deadline) {
      if (state.projectId === projectId && state.revisionHash) return state;
      await delay(250);
      state = await read();
    }
    throw new Error("Project mutation could not be verified.");
  };
  const unsupported = (name: string): never => {
    throw new Error(`unsupported:${name}`);
  };

  return {
    async listProjects(): Promise<ProjectRecord[]> {
      const outcome = await options.Runtime.evaluate({
        expression: buildProjectListRuntimeExpression(),
        returnByValue: true,
      });
      const value = outcome.result?.value;
      if (!Array.isArray(value)) throw new Error("unsupported:project-list");
      return value as ProjectRecord[];
    },
    async getProject(projectId: string): Promise<ProjectSnapshot> {
      return ensureProject(projectId);
    },
    async createProject(input): Promise<ProjectSnapshot> {
      const outcome = await options.Runtime.evaluate({
        expression: buildCreateProjectExpression(input.name, input.instructions ?? ""),
        returnByValue: true,
        awaitPromise: true,
      });
      const value = outcome.result?.value as { ok?: boolean; reason?: string } | undefined;
      if (!value?.ok) throw new Error(value?.reason ?? "unsupported:project-create");
      logger(`Created ChatGPT project ${input.name}.`);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const state = await read();
        if (state.name === input.name) return state;
        await delay(250);
      }
      throw new Error("Project create could not be verified.");
    },
    async renameProject(input): Promise<ProjectSnapshot> {
      const state = await ensureControl("projectControls");
      if (state.projectId !== input.projectId || state.revisionHash !== input.expectedRevisionHash)
        throw new Error("revision-conflict");
      return mutate(buildRenameProjectExpression(input.name), input.projectId);
    },
    async moveProject(_input): Promise<ProjectSnapshot> {
      return unsupported("project-move");
    },
    async deleteProject(input): Promise<void> {
      const state = await ensureControl("projectControls");
      if (state.projectId !== input.projectId || state.revisionHash !== input.expectedRevisionHash)
        throw new Error("revision-conflict");
      const outcome = await options.Runtime.evaluate({
        expression: buildDeleteProjectExpression(),
        returnByValue: true,
      });
      const value = outcome.result?.value as { ok?: boolean; reason?: string } | undefined;
      if (!value?.ok) throw new Error(value?.reason ?? "unsupported:project-delete");
    },
    async listProjectSources(projectId: string): Promise<ProjectSourceRecord[]> {
      return (await ensureProject(projectId)).sources;
    },
    async removeProjectSource(input): Promise<ProjectSnapshot> {
      const state = await ensureControl("sourceControls");
      if (state.projectId !== input.projectId || state.revisionHash !== input.expectedRevisionHash)
        throw new Error("revision-conflict");
      const outcome = await options.Runtime.evaluate({
        expression: buildRemoveSourceExpression(input.sourceId),
        returnByValue: true,
      });
      const value = outcome.result?.value as { ok?: boolean; reason?: string } | undefined;
      if (!value?.ok) throw new Error(value?.reason ?? "unsupported:source-remove");
      await delay(400);
      return ensureProject(input.projectId);
    },
    async branchProjectConversation(_input): Promise<ProjectConversationRecord> {
      return unsupported("conversation-branch");
    },
    async previewProjectShare(input): Promise<{
      projectId: string;
      revisionHash: string;
      target: ProjectShareTarget;
      external: boolean;
      unknown: boolean;
      summary: string;
      capability?: RuntimeProjectState["capability"];
    }> {
      const state = await ensureProject(input.projectId);
      if (state.revisionHash !== input.expectedRevisionHash) throw new Error("revision-conflict");
      const outcome = await options.Runtime.evaluate({
        expression: buildSharePreviewExpression(),
        returnByValue: true,
      });
      const value = outcome.result?.value as
        | { available?: boolean; external?: boolean; unknown?: boolean; summary?: string }
        | undefined;
      if (!value?.available) throw new Error("unsupported:project-share");
      return {
        projectId: input.projectId,
        revisionHash: state.revisionHash,
        target: input.target,
        external: value.external === true,
        unknown: value.unknown === true,
        summary:
          typeof value.summary === "string"
            ? value.summary
            : "Project sharing requires confirmation.",
        capability: state.capability,
      };
    },
    async shareProject(input): Promise<ProjectSnapshot> {
      const state = await ensureControl("shareControls");
      if (state.projectId !== input.projectId || state.revisionHash !== input.expectedRevisionHash)
        throw new Error("revision-conflict");
      const outcome = await options.Runtime.evaluate({
        expression: buildCommitShareExpression(input.target),
        returnByValue: true,
      });
      const value = outcome.result?.value as { ok?: boolean; reason?: string } | undefined;
      if (!value?.ok) throw new Error(value?.reason ?? "unsupported:project-share");
      await delay(500);
      return ensureProject(input.projectId);
    },
  };
}

function buildProjectLifecycleStateExpression(): string {
  return `(() => { const text = (value) => String(value || '').replace(/\\s+/g, ' ').trim(); const visible = (node) => { if (!(node instanceof HTMLElement)) return false; const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; }; const projectId = (location.pathname.match(/\\/g\\/(g-p-[^/]+)/) || [])[1] || ''; const url = location.href; const title = text(document.querySelector('button[name="project-title"]')?.textContent || document.querySelector('h1,h2,[role="heading"]')?.textContent) || 'Project'; const conversations = Array.from(document.querySelectorAll('a[href*="/c/"]')).flatMap((a) => { const href = a.href || ''; const id = (new URL(href, location.href).pathname.match(/\\/c\\/([^/?#]+)/) || [])[1]; if (!id) return []; const linkedProject = (new URL(href, location.href).pathname.match(/\\/g\\/(g-p-[^/]+)/) || [])[1] || projectId; if (linkedProject !== projectId) return []; return [{ conversationId: id, url: href, title: text(a.textContent || a.getAttribute('aria-label')) || 'Untitled', projectId: linkedProject }]; }); const seenConversations = new Set(); const uniqueConversations = conversations.filter((item) => !seenConversations.has(item.conversationId) && seenConversations.add(item.conversationId)); const sources = Array.from(document.querySelectorAll('[data-source-id], [data-testid*="source" i], [role="listitem"]')).flatMap((node, index) => { const name = text(node.textContent); if (!name || name.length > 240 || /add source|upload/i.test(name)) return []; const sourceId = node.getAttribute('data-source-id') || node.getAttribute('data-id') || 'source-' + index; return [{ sourceId, projectId, name, status: 'ready' }]; }); const seenSources = new Set(); const uniqueSources = sources.filter((item) => !seenSources.has(item.sourceId) && seenSources.add(item.sourceId)); const projectControls = Boolean(Array.from(document.querySelectorAll('button,[role="button"]')).find((node) => visible(node) && /project|settings|rename|delete/i.test(text(node.getAttribute('aria-label') || node.textContent)))); const sourceControls = Boolean(document.querySelector('[role="tab"][id*="source" i], [role="tabpanel"][id*="source" i], button[aria-label*="source" i]')); const shareControls = Boolean(Array.from(document.querySelectorAll('button,[role="button"]')).find((node) => visible(node) && /share/i.test(text(node.getAttribute('aria-label') || node.textContent)))); const pageIdentity = /chatgpt\\.(com|openai\\.com)$/.test(location.hostname) ? 'chatgpt_app' : 'other'; const loginState = /log in|sign in/i.test(document.body?.innerText || '') ? 'login_required' : pageIdentity === 'chatgpt_app' ? 'logged_in' : 'unknown'; const hashInput = JSON.stringify({ projectId, name: title, conversations: uniqueConversations.map((item) => item.conversationId), sources: uniqueSources.map((item) => item.sourceId) }); let hash = 2166136261; for (let i = 0; i < hashInput.length; i++) hash = Math.imul(hash ^ hashInput.charCodeAt(i), 16777619); const revisionHash = (hash >>> 0).toString(16).padStart(8, '0').repeat(8); return { projectId, revisionHash, name: title, url, memoryVisibility: 'unknown', conversations: uniqueConversations, sources: uniqueSources, capability: { pageIdentity, loginState, projectControls: projectControls ? 'available' : 'unknown', sourceControls: sourceControls ? 'available' : 'unknown', shareControls: shareControls ? 'available' : 'unknown' } }; })()`;
}

function buildProjectListRuntimeExpression(): string {
  return `(() => { const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim(); const seen = new Set(); return Array.from(document.querySelectorAll('a[href*="/g/g-p-"][href*="/project"]')).flatMap((a, index) => { const href = a.href || ''; const id = (new URL(href, location.href).pathname.match(/\\/g\\/(g-p-[^/]+)\\/project/) || [])[1]; const name = normalize(a.textContent || a.getAttribute('aria-label')); if (!id || !name || seen.has(id)) return []; seen.add(id); let hash = 2166136261; for (const ch of id + name) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619); return [{ projectId: id, revisionHash: (hash >>> 0).toString(16).padStart(8, '0').repeat(8), name, url: new URL(href, location.href).toString() }]; }); })()`;
}

function buildCreateProjectExpression(name: string, instructions: string): string {
  return `(${async function create(projectName: string, projectInstructions: string) {
    const response = await fetch("/backend-api/gizmos/snorlax/upsert", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instructions: projectInstructions,
        display: { name: projectName, description: "", prompt_starters: [] },
        gizmo: { name: projectName },
      }),
    });
    if (!response.ok) return { ok: false, reason: "Project create request failed." };
    return { ok: true };
  }.toString()})(${JSON.stringify(name)}, ${JSON.stringify(instructions)})`;
}

function buildRenameProjectExpression(name: string): string {
  return `(() => { const button = document.querySelector('button[name="project-title"]'); if (!(button instanceof HTMLElement)) return { ok: false, reason: 'unsupported:project-rename-control' }; button.click(); const input = document.querySelector('input[aria-label="Project name"]'); if (!(input instanceof HTMLInputElement)) return { ok: false, reason: 'unsupported:project-rename-input' }; input.value = ${JSON.stringify(name)}; input.dispatchEvent(new Event('input', { bubbles: true })); const save = Array.from(document.querySelectorAll('button,[role="button"]')).find((node) => /^(save|done)$/i.test(String(node.textContent || '').trim())); if (!(save instanceof HTMLElement)) return { ok: false, reason: 'unsupported:project-rename-save' }; save.click(); return { ok: true }; })()`;
}
function buildDeleteProjectExpression(): string {
  return `(() => { const menu = Array.from(document.querySelectorAll('button,[role="button"]')).find((node) => /project.*(option|menu)|more/i.test(String(node.getAttribute('aria-label') || node.textContent || ''))); if (!(menu instanceof HTMLElement)) return { ok: false, reason: 'unsupported:project-delete-menu' }; menu.click(); const item = Array.from(document.querySelectorAll('[role="menuitem"],button,[role="button"]')).find((node) => /delete project/i.test(String(node.textContent || node.getAttribute('aria-label') || ''))); if (!(item instanceof HTMLElement)) return { ok: false, reason: 'unsupported:project-delete-item' }; item.click(); const confirm = Array.from(document.querySelectorAll('button,[role="button"]')).find((node) => /^(delete|confirm)$/i.test(String(node.textContent || '').trim())); if (!(confirm instanceof HTMLElement)) return { ok: false, reason: 'unsupported:project-delete-confirm' }; confirm.click(); return { ok: true }; })()`;
}
function buildRemoveSourceExpression(sourceId: string): string {
  return `(() => { const id = ${JSON.stringify(sourceId)}; const row = document.querySelector('[data-source-id="' + CSS.escape(id) + '"], [data-id="' + CSS.escape(id) + '"]'); if (!(row instanceof HTMLElement)) return { ok: false, reason: 'unsupported:source-remove-row' }; const remove = Array.from(row.querySelectorAll('button,[role="button"]')).find((node) => /remove|delete/i.test(String(node.getAttribute('aria-label') || node.textContent || ''))); if (!(remove instanceof HTMLElement)) return { ok: false, reason: 'unsupported:source-remove-control' }; remove.click(); return { ok: true }; })()`;
}
function buildSharePreviewExpression(): string {
  return `(() => { const share = Array.from(document.querySelectorAll('button,[role="button"]')).find((node) => /share/i.test(String(node.getAttribute('aria-label') || node.textContent || ''))); if (!(share instanceof HTMLElement)) return { available: false, unknown: true }; return { available: true, external: false, unknown: false, summary: 'Project share target is ready for explicit confirmation.' }; })()`;
}
function buildCommitShareExpression(target: ProjectShareTarget): string {
  return `(() => { const target = ${JSON.stringify(target)}; if (!target || !target.kind) return { ok: false, reason: 'unsupported:share-target' }; const share = Array.from(document.querySelectorAll('button,[role="button"]')).find((node) => /share/i.test(String(node.getAttribute('aria-label') || node.textContent || ''))); if (!(share instanceof HTMLElement)) return { ok: false, reason: 'unsupported:project-share-control' }; share.click(); const confirm = Array.from(document.querySelectorAll('button,[role="button"]')).find((node) => /^(share|send|confirm)$/i.test(String(node.textContent || '').trim())); if (!(confirm instanceof HTMLElement)) return { ok: false, reason: 'unsupported:project-share-confirm' }; confirm.click(); return { ok: true }; })()`;
}

export const projectLifecycleExpressionsForTest = {
  buildProjectLifecycleStateExpression,
  buildProjectListRuntimeExpression,
  buildRenameProjectExpression,
  buildDeleteProjectExpression,
  buildRemoveSourceExpression,
  buildSharePreviewExpression,
  buildCommitShareExpression,
};
