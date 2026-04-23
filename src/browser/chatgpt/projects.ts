import { connectToRemoteChrome, closeRemoteChromeTarget } from "../chromeLifecycle.js";
import { resolveBrowserConfig } from "../config.js";
import { CHATGPT_URL } from "../constants.js";
import { navigateToChatGPT } from "../actions/navigation.js";
import { delay } from "../utils.js";
import type { BrowserAutomationConfig, BrowserLogger, ChromeClient } from "../types.js";
import { snapshotChatgptPage } from "./imageArtifacts.js";
import type {
  ChatgptConversationDeleteResult,
  ChatgptConversationDeletePlanResult,
  ChatgptConversationMoveResult,
  ChatgptProjectConversationRef,
  ChatgptProjectCreateResult,
  ChatgptProjectListResult,
  ChatgptProjectRef,
  ChatgptProjectRenameResult,
  ChatgptProjectSnapshotResult,
} from "./types.js";

export interface ListChatgptProjectsOptions {
  config?: BrowserAutomationConfig;
  timeoutMs?: number;
  keepTab?: boolean;
  log?: BrowserLogger;
}

export interface ReadChatgptProjectOptions {
  projectUrl: string;
  config?: BrowserAutomationConfig;
  timeoutMs?: number;
  keepTab?: boolean;
  log?: BrowserLogger;
}

export interface CreateChatgptProjectOptions {
  name: string;
  instructions?: string;
  config?: BrowserAutomationConfig;
  timeoutMs?: number;
  keepTab?: boolean;
  log?: BrowserLogger;
}

export interface PlanChatgptConversationDeleteOptions {
  conversationUrl: string;
  config?: BrowserAutomationConfig;
  timeoutMs?: number;
  keepTab?: boolean;
  log?: BrowserLogger;
}

export interface DeleteChatgptConversationOptions extends PlanChatgptConversationDeleteOptions {
  confirmConversationId: string;
}

export interface MoveChatgptConversationOptions {
  conversationUrl: string;
  targetProjectUrl: string;
  confirmConversationId: string;
  config?: BrowserAutomationConfig;
  timeoutMs?: number;
  keepTab?: boolean;
  log?: BrowserLogger;
}

export interface RenameChatgptProjectOptions {
  projectUrl: string;
  newName: string;
  confirmCurrentName: string;
  config?: BrowserAutomationConfig;
  timeoutMs?: number;
  keepTab?: boolean;
  log?: BrowserLogger;
}

export async function listChatgptProjects(
  options: ListChatgptProjectsOptions = {},
): Promise<ChatgptProjectListResult> {
  const logger = options.log ?? ((_message: string) => {});
  const config = resolveBrowserConfig(options.config);
  const remoteChrome = config.remoteChrome;
  if (!remoteChrome) {
    throw new Error("ChatGPT project listing requires browser.remoteChrome or --remote-chrome.");
  }
  const connection = await connectToRemoteChrome(
    remoteChrome.host,
    remoteChrome.port,
    logger,
    config.chatgptUrl ?? config.url ?? CHATGPT_URL,
    { maxTabs: config.remoteChromeMaxTabs },
  );
  const client = connection.client;
  try {
    const { Page, Runtime } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    await navigateToChatGPT(Page, Runtime, config.chatgptUrl ?? config.url ?? CHATGPT_URL, logger);
    await waitForDocumentReady(Runtime, options.timeoutMs ?? 20_000);
    const projects = await waitForProjects(Runtime, options.timeoutMs ?? 20_000);
    const page = await snapshotChatgptPage(Runtime);
    return { page, projects, warnings: [] };
  } finally {
    try {
      await client.close();
    } finally {
      if (!options.keepTab) {
        await closeRemoteChromeTarget(
          remoteChrome.host,
          remoteChrome.port,
          connection.targetId,
          logger,
        );
      }
    }
  }
}

export async function readChatgptProject(
  options: ReadChatgptProjectOptions,
): Promise<ChatgptProjectSnapshotResult> {
  const logger = options.log ?? ((_message: string) => {});
  const config = resolveBrowserConfig(options.config);
  const remoteChrome = config.remoteChrome;
  if (!remoteChrome) {
    throw new Error("ChatGPT project snapshot requires browser.remoteChrome or --remote-chrome.");
  }
  const connection = await connectToRemoteChrome(
    remoteChrome.host,
    remoteChrome.port,
    logger,
    options.projectUrl,
    { maxTabs: config.remoteChromeMaxTabs },
  );
  const client = connection.client;
  try {
    const { Page, Runtime } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    await navigateToChatGPT(Page, Runtime, options.projectUrl, logger);
    await waitForDocumentReady(Runtime, options.timeoutMs ?? 20_000);
    const page = await snapshotChatgptPage(Runtime);
    const fallbackProject = await readCurrentProjectFromRuntime(Runtime, options.projectUrl);
    const projectId = fallbackProject.projectId ?? projectIdFromUrl(options.projectUrl);
    const listedProjects = await readProjectsFromRuntime(Runtime);
    const project =
      listedProjects.find((candidate) => candidate.projectId && candidate.projectId === projectId) ??
      fallbackProject;
    const conversations = await waitForProjectConversations(Runtime, options.timeoutMs ?? 20_000);
    return { page, project, conversations, warnings: [] };
  } finally {
    try {
      await client.close();
    } finally {
      if (!options.keepTab) {
        await closeRemoteChromeTarget(
          remoteChrome.host,
          remoteChrome.port,
          connection.targetId,
          logger,
        );
      }
    }
  }
}

export async function createChatgptProject(
  options: CreateChatgptProjectOptions,
): Promise<ChatgptProjectCreateResult> {
  const logger = options.log ?? ((_message: string) => {});
  const name = options.name.trim();
  if (!name) {
    throw new Error("Project create requires a non-empty name.");
  }
  if (name.length > 50) {
    throw new Error("Project names cannot be longer than 50 characters.");
  }
  const instructions = options.instructions?.trim() ?? "";
  if (instructions.length > 8_000) {
    throw new Error("Project instructions cannot be longer than 8000 characters.");
  }
  const config = resolveBrowserConfig(options.config);
  const remoteChrome = config.remoteChrome;
  if (!remoteChrome) {
    throw new Error("ChatGPT project creation requires browser.remoteChrome or --remote-chrome.");
  }
  const connection = await connectToRemoteChrome(
    remoteChrome.host,
    remoteChrome.port,
    logger,
    config.chatgptUrl ?? config.url ?? CHATGPT_URL,
    { maxTabs: config.remoteChromeMaxTabs },
  );
  const client = connection.client;
  try {
    const { Page, Runtime } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    await navigateToChatGPT(Page, Runtime, config.chatgptUrl ?? config.url ?? CHATGPT_URL, logger);
    await waitForDocumentReady(Runtime, options.timeoutMs ?? 20_000);
    const pageBefore = await snapshotChatgptPage(Runtime);
    if (!pageBefore.loginLikely) {
      throw new Error("Refusing to create project because the ChatGPT page is not logged in.");
    }

    const project = await createProjectViaSessionApi(Runtime, name, instructions);
    await navigateToChatGPT(Page, Runtime, project.url ?? config.chatgptUrl ?? CHATGPT_URL, logger);
    await waitForDocumentReady(Runtime, options.timeoutMs ?? 20_000);
    await delay(1_500);
    const pageAfter = await snapshotChatgptPage(Runtime);
    const projectAfter = await readCurrentProjectFromRuntime(Runtime, project.url ?? pageAfter.href);
    const verification =
      pageAfter.href.includes(`/g/${project.projectId ?? ""}/project`) ||
      (project.url ? normalizeUrl(pageAfter.href) === normalizeUrl(project.url) : false) ||
      projectAfter.projectId === project.projectId
        ? "project_page_opened"
        : project.projectId
          ? "response_project_id"
          : "not_verified";
    return {
      pageBefore,
      pageAfter,
      project: {
        ...project,
        name:
          projectAfter.name === "Project" ||
          projectAfter.name === projectNameFromProjectId(project.projectId)
            ? project.name
            : projectAfter.name,
      },
      created: verification !== "not_verified",
      verification,
      warnings:
        verification === "not_verified"
          ? ["Project create returned, but the created project page could not be verified."]
          : [],
    };
  } finally {
    try {
      await client.close();
    } finally {
      if (!options.keepTab) {
        await closeRemoteChromeTarget(
          remoteChrome.host,
          remoteChrome.port,
          connection.targetId,
          logger,
        );
      }
    }
  }
}

export async function planChatgptConversationDelete(
  options: PlanChatgptConversationDeleteOptions,
): Promise<ChatgptConversationDeletePlanResult> {
  const logger = options.log ?? ((_message: string) => {});
  const config = resolveBrowserConfig(options.config);
  const remoteChrome = config.remoteChrome;
  if (!remoteChrome) {
    throw new Error("ChatGPT delete planning requires browser.remoteChrome or --remote-chrome.");
  }
  const connection = await connectToRemoteChrome(
    remoteChrome.host,
    remoteChrome.port,
    logger,
    options.conversationUrl,
    { maxTabs: config.remoteChromeMaxTabs },
  );
  const client = connection.client;
  try {
    const { Page, Runtime } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    await navigateToChatGPT(Page, Runtime, options.conversationUrl, logger);
    await waitForDocumentReady(Runtime, options.timeoutMs ?? 20_000);
    const page = await snapshotChatgptPage(Runtime);
    const conversationId = conversationIdFromUrl(options.conversationUrl);
    const conversations = await readProjectConversationsFromRuntime(Runtime);
    const matchedConversation = conversations.find((conversation) => {
      if (conversationId && conversation.conversationId === conversationId) return true;
      return normalizeUrl(conversation.url) === normalizeUrl(options.conversationUrl);
    });
    const warnings: string[] = [];
    if (!conversationId) {
      warnings.push("Could not parse a ChatGPT conversation id from the supplied URL.");
    }
    if (!matchedConversation) {
      warnings.push("Conversation was not found in the currently visible ChatGPT navigation.");
    }
    return {
      page,
      conversationUrl: options.conversationUrl,
      conversationId: conversationId ?? undefined,
      matchedConversation,
      canAttemptDelete: Boolean(conversationId && page.loginLikely && page.hasComposer),
      warnings,
    };
  } finally {
    try {
      await client.close();
    } finally {
      if (!options.keepTab) {
        await closeRemoteChromeTarget(
          remoteChrome.host,
          remoteChrome.port,
          connection.targetId,
          logger,
        );
      }
    }
  }
}

export async function deleteChatgptConversation(
  options: DeleteChatgptConversationOptions,
): Promise<ChatgptConversationDeleteResult> {
  const logger = options.log ?? ((_message: string) => {});
  const conversationId = conversationIdFromUrl(options.conversationUrl);
  if (!conversationId) {
    throw new Error("Could not parse a ChatGPT conversation id from the supplied URL.");
  }
  if (options.confirmConversationId !== conversationId) {
    throw new Error(
      `Refusing to delete ${conversationId}: confirmation id ${options.confirmConversationId} does not match.`,
    );
  }
  const config = resolveBrowserConfig(options.config);
  const remoteChrome = config.remoteChrome;
  if (!remoteChrome) {
    throw new Error("ChatGPT deletion requires browser.remoteChrome or --remote-chrome.");
  }
  const connection = await connectToRemoteChrome(
    remoteChrome.host,
    remoteChrome.port,
    logger,
    options.conversationUrl,
    { maxTabs: config.remoteChromeMaxTabs },
  );
  const client = connection.client;
  try {
    const { Page, Runtime } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    await navigateToChatGPT(Page, Runtime, options.conversationUrl, logger);
    await waitForDocumentReady(Runtime, options.timeoutMs ?? 20_000);
    const pageBefore = await snapshotChatgptPage(Runtime);
    const conversations = await readProjectConversationsFromRuntime(Runtime);
    const matchedConversation = conversations.find((conversation) => {
      if (conversation.conversationId === conversationId) return true;
      return normalizeUrl(conversation.url) === normalizeUrl(options.conversationUrl);
    });
    if (!pageBefore.loginLikely || !pageBefore.hasComposer) {
      throw new Error("Refusing to delete because the ChatGPT conversation page is not ready.");
    }

    await clickConversationOptions(Runtime);
    await delay(500);
    await clickDeleteMenuItem(Runtime);
    await delay(500);
    await clickConfirmDelete(Runtime);
    await delay(2_000);
    const pageAfter = await snapshotChatgptPage(Runtime);
    const verification = pageAfter.href.includes(`/c/${conversationId}`)
      ? "not_verified"
      : "url_changed";
    return {
      pageBefore,
      pageAfter,
      conversationUrl: options.conversationUrl,
      conversationId,
      matchedConversation,
      deleted: verification !== "not_verified",
      verification,
      warnings:
        verification === "not_verified"
          ? ["Delete confirmation was clicked, but the browser still appears to be on the target conversation URL."]
          : [],
    };
  } finally {
    try {
      await client.close();
    } finally {
      if (!options.keepTab) {
        await closeRemoteChromeTarget(
          remoteChrome.host,
          remoteChrome.port,
          connection.targetId,
          logger,
        );
      }
    }
  }
}

export async function moveChatgptConversationToProject(
  options: MoveChatgptConversationOptions,
): Promise<ChatgptConversationMoveResult> {
  const logger = options.log ?? ((_message: string) => {});
  const conversationId = conversationIdFromUrl(options.conversationUrl);
  if (!conversationId) {
    throw new Error("Could not parse a ChatGPT conversation id from the supplied URL.");
  }
  if (options.confirmConversationId !== conversationId) {
    throw new Error(
      `Refusing to move ${conversationId}: confirmation id ${options.confirmConversationId} does not match.`,
    );
  }
  const targetProjectId = projectIdFromUrl(options.targetProjectUrl);
  if (!targetProjectId) {
    throw new Error("Could not parse a ChatGPT project id from the target project URL.");
  }
  const config = resolveBrowserConfig(options.config);
  const remoteChrome = config.remoteChrome;
  if (!remoteChrome) {
    throw new Error("ChatGPT project move requires browser.remoteChrome or --remote-chrome.");
  }
  const connection = await connectToRemoteChrome(
    remoteChrome.host,
    remoteChrome.port,
    logger,
    options.conversationUrl,
    { maxTabs: config.remoteChromeMaxTabs },
  );
  const client = connection.client;
  try {
    const { Page, Runtime } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    await navigateToChatGPT(Page, Runtime, options.conversationUrl, logger);
    await waitForDocumentReady(Runtime, options.timeoutMs ?? 20_000);
    const pageBefore = await snapshotChatgptPage(Runtime);
    if (!pageBefore.loginLikely || !pageBefore.hasComposer) {
      throw new Error("Refusing to move because the ChatGPT conversation page is not ready.");
    }

    await clickConversationOptions(Runtime);
    await delay(500);
    await clickMoveToProjectMenuItem(Runtime);
    await delay(500);
    const targetProject = await clickProjectInMoveMenu(Runtime, options.targetProjectUrl);
    let pageAfter = await snapshotChatgptPage(Runtime);
    let movedConversation: ChatgptProjectConversationRef | undefined;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await delay(750);
      pageAfter = await snapshotChatgptPage(Runtime);
      const conversations = await readProjectConversationsFromRuntime(Runtime);
      movedConversation = conversations.find((conversation) => {
        if (conversation.conversationId !== conversationId) return false;
        return (
          conversation.projectId === targetProjectId ||
          conversation.url.includes(`/g/${targetProjectId}/`)
        );
      });
      if (movedConversation) {
        break;
      }
    }
    const verification = movedConversation
      ? "project_link_found"
      : pageAfter.title.startsWith(`${targetProject.name} -`) ||
          pageAfter.title === targetProject.name
        ? "page_title_project"
      : pageAfter.href.includes(`/g/${targetProjectId}/`) && pageAfter.href.includes(`/c/${conversationId}`)
        ? "url_changed_to_project"
        : "not_verified";
    return {
      pageBefore,
      pageAfter,
      conversationUrl: options.conversationUrl,
      conversationId,
      targetProject,
      movedConversation,
      moved: verification !== "not_verified",
      verification,
      warnings:
        verification === "not_verified"
          ? ["Move target was clicked, but the moved conversation was not verified in the target project."]
          : [],
    };
  } finally {
    try {
      await client.close();
    } finally {
      if (!options.keepTab) {
        await closeRemoteChromeTarget(
          remoteChrome.host,
          remoteChrome.port,
          connection.targetId,
          logger,
        );
      }
    }
  }
}

export async function renameChatgptProject(
  options: RenameChatgptProjectOptions,
): Promise<ChatgptProjectRenameResult> {
  const logger = options.log ?? ((_message: string) => {});
  const targetProjectId = projectIdFromUrl(options.projectUrl);
  if (!targetProjectId) {
    throw new Error("Could not parse a ChatGPT project id from the supplied URL.");
  }
  const newName = options.newName.trim();
  if (!newName) {
    throw new Error("Project rename requires a non-empty new name.");
  }
  const config = resolveBrowserConfig(options.config);
  const remoteChrome = config.remoteChrome;
  if (!remoteChrome) {
    throw new Error("ChatGPT project rename requires browser.remoteChrome or --remote-chrome.");
  }
  const connection = await connectToRemoteChrome(
    remoteChrome.host,
    remoteChrome.port,
    logger,
    options.projectUrl,
    { maxTabs: config.remoteChromeMaxTabs },
  );
  const client = connection.client;
  try {
    const { Page, Runtime } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    await navigateToChatGPT(Page, Runtime, options.projectUrl, logger);
    await waitForDocumentReady(Runtime, options.timeoutMs ?? 20_000);
    await waitForProjectTitleReady(Runtime, options.timeoutMs ?? 20_000);
    const pageBefore = await snapshotChatgptPage(Runtime);
    const projectBefore = await readCurrentProjectFromRuntime(Runtime, options.projectUrl);
    if (projectBefore.name !== options.confirmCurrentName) {
      throw new Error(
        `Refusing to rename project ${targetProjectId}: current name ${JSON.stringify(projectBefore.name)} does not match confirmation ${JSON.stringify(options.confirmCurrentName)}.`,
      );
    }

    await openProjectRenameEditor(Runtime, projectBefore.name);
    await fillProjectRenameEditor(Runtime, newName);
    await delay(3_000);
    await closeProjectDetailsDialog(Runtime);
    await delay(1_000);
    const pageAfter = await snapshotChatgptPage(Runtime);
    const listedProjects = await readProjectsFromRuntime(Runtime);
    const projectAfter =
      listedProjects.find((candidate) => candidate.projectId === targetProjectId) ??
      (await readCurrentProjectFromRuntime(Runtime, options.projectUrl));
    const verification =
      projectAfter.name === newName
        ? newName === projectBefore.name
          ? "unchanged_same_name"
          : "name_updated"
        : "not_verified";
    return {
      pageBefore,
      pageAfter,
      projectBefore,
      projectAfter,
      oldName: projectBefore.name,
      newName,
      renamed: verification !== "not_verified",
      verification,
      warnings:
        verification === "not_verified"
          ? ["Rename was submitted, but the updated project name was not verified."]
          : [],
    };
  } finally {
    try {
      await client.close();
    } finally {
      if (!options.keepTab) {
        await closeRemoteChromeTarget(
          remoteChrome.host,
          remoteChrome.port,
          connection.targetId,
          logger,
        );
      }
    }
  }
}

async function waitForProjects(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
): Promise<ChatgptProjectRef[]> {
  const deadline = Date.now() + timeoutMs;
  let projects = await readProjectsFromRuntime(Runtime);
  while (Date.now() < deadline) {
    if (projects.length > 0) {
      return projects;
    }
    await delay(400);
    projects = await readProjectsFromRuntime(Runtime);
  }
  return projects;
}

async function waitForProjectConversations(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
): Promise<ChatgptProjectConversationRef[]> {
  const deadline = Date.now() + timeoutMs;
  let conversations = await readProjectConversationsFromRuntime(Runtime);
  while (Date.now() < deadline) {
    if (conversations.some((conversation) => /\/g\/g-p-[^/]+\/c\//.test(conversation.url))) {
      return conversations;
    }
    await delay(400);
    conversations = await readProjectConversationsFromRuntime(Runtime);
  }
  return conversations;
}

async function waitForProjectTitleReady(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const visible = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        return Boolean(
          Array.from(document.querySelectorAll('button[name="project-title"], input[aria-label="Project name"]')).find(visible)
        );
      })()`,
      returnByValue: true,
    });
    if (result?.value === true) {
      return;
    }
    await delay(250);
  }
}

async function readProjectsFromRuntime(
  Runtime: ChromeClient["Runtime"],
): Promise<ChatgptProjectRef[]> {
  const { result } = await Runtime.evaluate({
    expression: buildProjectListExpression(),
    returnByValue: true,
  });
  const value = result?.value;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): ChatgptProjectRef[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Partial<ChatgptProjectRef>;
    if (typeof item.name !== "string" || !item.name.trim()) return [];
    return [
      {
        name: item.name.trim(),
        url: typeof item.url === "string" && item.url ? item.url : undefined,
        projectId:
          typeof item.projectId === "string" && item.projectId ? item.projectId : undefined,
        documentIndex:
          typeof item.documentIndex === "number" && Number.isFinite(item.documentIndex)
            ? item.documentIndex
            : 0,
      },
    ];
  });
}

async function waitForDocumentReady(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: "document.readyState",
      returnByValue: true,
    });
    if (result?.value === "interactive" || result?.value === "complete") {
      return;
    }
    await delay(250);
  }
}

function buildProjectListExpression(): string {
  return `(() => {
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const projectIdFromUrl = (url) => {
      try {
        const parsed = new URL(url, location.href);
        const match = parsed.pathname.match(/\\/g\\/(g-p-[^/]+)\\/project/);
        return match ? match[1] : null;
      } catch {
        return null;
      }
    };
    const candidates = [];
    Array.from(document.querySelectorAll("a")).forEach((anchor, documentIndex) => {
      const href = anchor.href || anchor.getAttribute("href") || "";
      const hasProjectIcon = Boolean(anchor.querySelector('[data-testid="project-folder-icon"]'));
      const projectId = projectIdFromUrl(href);
      if (!hasProjectIcon && !projectId) return;
      const name = normalize(anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label"));
      if (!name) return;
      candidates.push({
        name,
        url: href ? new URL(href, location.href).toString() : undefined,
        projectId: projectId || undefined,
        documentIndex
      });
    });
    const seen = new Set();
    return candidates.filter((item) => {
      const key = item.projectId || item.url || item.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })()`;
}

async function readCurrentProjectFromRuntime(
  Runtime: ChromeClient["Runtime"],
  fallbackUrl: string,
): Promise<ChatgptProjectRef> {
  const { result } = await Runtime.evaluate({
    expression: buildCurrentProjectExpression(fallbackUrl),
    returnByValue: true,
  });
  const value = result?.value as Partial<ChatgptProjectRef> | undefined;
  const fallbackId = projectIdFromUrl(fallbackUrl);
  return {
    name:
      typeof value?.name === "string" && value.name.trim() && value.name.trim() !== "Chat history"
        ? value.name.trim()
        : projectNameFromProjectId(fallbackId) ?? "Project",
    url: typeof value?.url === "string" && value.url ? value.url : fallbackUrl,
    projectId:
      typeof value?.projectId === "string" && value.projectId ? value.projectId : fallbackId,
    documentIndex:
      typeof value?.documentIndex === "number" && Number.isFinite(value.documentIndex)
        ? value.documentIndex
        : 0,
  };
}

async function readProjectConversationsFromRuntime(
  Runtime: ChromeClient["Runtime"],
): Promise<ChatgptProjectConversationRef[]> {
  const { result } = await Runtime.evaluate({
    expression: buildConversationListExpression(),
    returnByValue: true,
  });
  const value = result?.value;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): ChatgptProjectConversationRef[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Partial<ChatgptProjectConversationRef>;
    if (typeof item.url !== "string" || !item.url) return [];
    const conversationId = conversationIdFromUrl(item.url);
    return [
      {
        title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : "Untitled",
        url: item.url,
        conversationId:
          typeof item.conversationId === "string" && item.conversationId
            ? item.conversationId
            : conversationId,
        projectId:
          typeof item.projectId === "string" && item.projectId ? item.projectId : undefined,
        documentIndex:
          typeof item.documentIndex === "number" && Number.isFinite(item.documentIndex)
            ? item.documentIndex
            : 0,
      },
    ];
  });
}

function buildCurrentProjectExpression(fallbackUrl: string): string {
  return `(() => {
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const fallbackUrl = ${JSON.stringify(fallbackUrl)};
    const projectIdFromUrl = (url) => {
      try {
        const parsed = new URL(url, location.href);
        const match = parsed.pathname.match(/\\/g\\/(g-p-[^/]+)\\/project/);
        return match ? match[1] : null;
      } catch {
        return null;
      }
    };
    const currentProjectId = projectIdFromUrl(location.href) || projectIdFromUrl(fallbackUrl);
    const anchors = Array.from(document.querySelectorAll("a"));
    const currentAnchor = anchors.find((anchor) => projectIdFromUrl(anchor.href || anchor.getAttribute("href") || "") === currentProjectId);
    const titleButton = Array.from(document.querySelectorAll('button[name="project-title"]')).find((node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const heading = Array.from(document.querySelectorAll("h1,h2,[role='heading']")).find((node) => normalize(node.textContent));
    const name = normalize(titleButton?.textContent || currentAnchor?.innerText || currentAnchor?.textContent || heading?.textContent) || "Project";
    return {
      name,
      url: currentAnchor?.href || fallbackUrl,
      projectId: currentProjectId || undefined,
      documentIndex: currentAnchor ? anchors.indexOf(currentAnchor) : 0
    };
  })()`;
}

function buildConversationListExpression(): string {
  return `(() => {
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const conversationIdFromUrl = (url) => {
      try {
        const parsed = new URL(url, location.href);
        const match = parsed.pathname.match(/\\/c\\/([^/?#]+)/);
        return match ? match[1] : null;
      } catch {
        return null;
      }
    };
    const projectIdFromHref = (href) => {
      try {
        const parsed = new URL(href, location.href);
        const match = parsed.pathname.match(/\\/g\\/(g-p-[^/]+)(?:\\/project|\\/c\\/[^/?#]+)?/);
        return match ? match[1] : null;
      } catch {
        return null;
      }
    };
    const currentProjectId = projectIdFromHref(location.href);
    const items = [];
    Array.from(document.querySelectorAll("a")).forEach((anchor, documentIndex) => {
      const href = anchor.href || anchor.getAttribute("href") || "";
      const conversationId = conversationIdFromUrl(href);
      if (!conversationId) return;
      const title = normalize(
        anchor.innerText ||
        anchor.textContent ||
        anchor.getAttribute("aria-label") ||
        anchor.getAttribute("title")
      );
      if (/^skip to content$/i.test(title)) return;
      items.push({
        title: title || "Untitled",
        url: new URL(href, location.href).toString(),
        conversationId,
        projectId: projectIdFromHref(href) || currentProjectId || undefined,
        documentIndex
      });
    });
    const seen = new Set();
    return items.filter((item) => {
      if (seen.has(item.conversationId)) return false;
      seen.add(item.conversationId);
      return true;
    });
  })()`;
}

async function createProjectViaSessionApi(
  Runtime: ChromeClient["Runtime"],
  name: string,
  instructions: string,
): Promise<ChatgptProjectRef> {
  const { result, exceptionDetails } = await Runtime.evaluate({
    expression: `(${async (projectName: string, projectInstructions: string) => {
      const bootstrapText = document.getElementById("client-bootstrap")?.textContent;
      const bootstrap =
        (window as any).CLIENT_BOOTSTRAP ?? (bootstrapText ? JSON.parse(bootstrapText) : {});
      const token = bootstrap.session?.accessToken;
      if (!token) {
        return { ok: false, reason: "ChatGPT session access token was not available." };
      }
      const response = await fetch("/backend-api/gizmos/snorlax/upsert", {
        method: "POST",
        credentials: "include",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          instructions: projectInstructions,
          display: {
            name: projectName,
            description: "",
            prompt_starters: [],
          },
          tools: [],
          memory_scope: "unset",
          files: [],
          training_disabled: false,
          sharing: [
            {
              type: "private",
              capabilities: {
                can_read: true,
                can_view_config: false,
                can_write: false,
                can_delete: false,
                can_export: false,
                can_share: false,
              },
            },
          ],
        }),
      });
      const text = await response.text();
      let payload: any;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = undefined;
      }
      if (!response.ok) {
        return {
          ok: false,
          reason: `Project create failed with HTTP ${response.status}: ${text.slice(0, 300)}`,
        };
      }
      const gizmo = payload?.resource?.gizmo;
      const projectId = gizmo?.id;
      const shortUrl = gizmo?.short_url;
      if (typeof projectId !== "string" || !projectId.startsWith("g-p-")) {
        return { ok: false, reason: "Project create did not return a project id." };
      }
      const projectUrl =
        typeof shortUrl === "string" && shortUrl
          ? `${location.origin}/g/${shortUrl}/project`
          : `${location.origin}/g/${projectId}/project`;
      return {
        ok: true,
        project: {
          name: gizmo?.display?.name || projectName,
          url: projectUrl,
          projectId,
          documentIndex: 0,
        },
      };
    }})(${JSON.stringify(name)}, ${JSON.stringify(instructions)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.text ?? "project create evaluation failed");
  }
  const value = result?.value as
    | { ok?: boolean; reason?: string; project?: ChatgptProjectRef }
    | undefined;
  if (!value?.ok || !value.project) {
    throw new Error(value?.reason ?? "project create failed");
  }
  return value.project;
}

async function clickConversationOptions(Runtime: ChromeClient["Runtime"]): Promise<void> {
  const clicked = await clickRuntimeElement(
    Runtime,
    `(() => {
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      if (Array.from(document.querySelectorAll('[data-testid="delete-chat-menu-item"],[data-testid="delete-conversation-confirm-button"]')).some(visible)) {
        return { ok: true };
      }
      const candidates = Array.from(document.querySelectorAll('button,[role="button"]')).filter((node) => {
        const text = [node.textContent || '', node.getAttribute?.('aria-label') || '', node.getAttribute?.('title') || '', node.getAttribute?.('data-testid') || '', node.id || ''].join(' ');
        return /conversation-options-button|conversation options|more options|open options|options/i.test(text);
      }).filter(visible);
      const selected = candidates.find((node) => /conversation-options-button/i.test(node.getAttribute?.('data-testid') || node.id || '')) || candidates.at(-1);
      if (!selected) return { ok: false, reason: 'conversation options button not found' };
      selected.click();
      return { ok: true };
    })()`,
  );
  if (!clicked.ok) {
    throw new Error(clicked.reason);
  }
}

async function clickDeleteMenuItem(Runtime: ChromeClient["Runtime"]): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastReason = "delete menu item not found";
  while (Date.now() < deadline) {
    const clicked = await clickRuntimeElement(
      Runtime,
      `(() => {
        const visible = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        if (Array.from(document.querySelectorAll('[data-testid="delete-conversation-confirm-button"]')).some(visible)) {
          return { ok: true };
        }
        const candidates = Array.from(document.querySelectorAll('[data-testid="delete-chat-menu-item"],[role="menuitem"],button,[role="button"]')).filter((node) => {
          const text = [node.textContent || '', node.getAttribute?.('aria-label') || '', node.getAttribute?.('title') || '', node.getAttribute?.('data-testid') || ''].join(' ').replace(/\\s+/g, ' ').trim();
          return /\\bdelete\\b|delete-chat-menu-item/i.test(text) && !/account|memory|all chats/i.test(text);
        }).filter(visible);
        const selected = candidates.find((node) => /delete-chat-menu-item/i.test(node.getAttribute?.('data-testid') || '')) || candidates.find((node) => /^delete$/i.test((node.textContent || '').trim())) || candidates[0];
        if (selected) {
          selected.click();
          return { ok: true };
        }
        const options = Array.from(document.querySelectorAll('[data-testid="conversation-options-button"],button,[role="button"]')).find((node) => {
          const text = [node.textContent || '', node.getAttribute?.('aria-label') || '', node.getAttribute?.('title') || '', node.getAttribute?.('data-testid') || '', node.id || ''].join(' ');
          return /conversation-options-button|conversation options/i.test(text) && visible(node);
        });
        if (options) {
          options.click();
          return { ok: false, reason: 'opened conversation options; waiting for delete menu item' };
        }
        return { ok: false, reason: 'delete menu item not found' };
      })()`,
    );
    if (clicked.ok) {
      return;
    }
    lastReason = clicked.reason;
    await delay(300);
  }
  throw new Error(lastReason);
}

async function clickMoveToProjectMenuItem(Runtime: ChromeClient["Runtime"]): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastReason = "move to project menu item not found";
  while (Date.now() < deadline) {
    const clicked = await clickRuntimeElement(
      Runtime,
      `(() => {
        const visible = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const candidates = Array.from(document.querySelectorAll('[role="menuitem"],button,[role="button"]')).filter((node) => {
          const text = [node.textContent || '', node.getAttribute?.('aria-label') || '', node.getAttribute?.('title') || ''].join(' ').replace(/\\s+/g, ' ').trim();
          return /^move to project$/i.test(text);
        }).filter(visible);
        const selected = candidates[0];
        if (selected) {
          selected.click();
          return { ok: true };
        }
        const options = Array.from(document.querySelectorAll('[data-testid="conversation-options-button"],button,[role="button"]')).find((node) => {
          const text = [node.textContent || '', node.getAttribute?.('aria-label') || '', node.getAttribute?.('title') || '', node.getAttribute?.('data-testid') || '', node.id || ''].join(' ');
          return /conversation-options-button|conversation options/i.test(text) && visible(node);
        });
        if (options) {
          options.click();
          return { ok: false, reason: 'opened conversation options; waiting for move menu item' };
        }
        return { ok: false, reason: 'move to project menu item not found' };
      })()`,
    );
    if (clicked.ok) {
      return;
    }
    lastReason = clicked.reason;
    await delay(300);
  }
  throw new Error(lastReason);
}

async function clickProjectInMoveMenu(
  Runtime: ChromeClient["Runtime"],
  targetProjectUrl: string,
): Promise<ChatgptProjectRef> {
  const targetProjectId = projectIdFromUrl(targetProjectUrl);
  const deadline = Date.now() + 10_000;
  let lastReason = "target project menu item not found";
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const targetProjectId = ${JSON.stringify(targetProjectId)};
        const targetProjectUrl = ${JSON.stringify(normalizeUrl(targetProjectUrl))};
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const visible = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const projectIdFromHref = (href) => {
          try {
            const parsed = new URL(href, location.href);
            const match = parsed.pathname.match(/\\/g\\/(g-p-[^/]+)(?:\\/project)?/);
            return match ? match[1] : null;
          } catch {
            return null;
          }
        };
        const dispatchFullClick = (node) => {
          for (const type of ['pointerover', 'mouseover', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
          }
        };
        const candidates = Array.from(document.querySelectorAll('a,[role="menuitem"]')).filter((node) => {
          if (!visible(node)) return false;
          const rect = node.getBoundingClientRect();
          const href = node.href || node.getAttribute?.('href') || '';
          const normalizedHref = href ? new URL(href, location.href).toString().replace(/\\/$/, '') : '';
          const projectId = projectIdFromHref(href);
          return rect.x > 300 && (projectId === targetProjectId || normalizedHref === targetProjectUrl);
        });
        const selected = candidates[0];
        if (!selected) return { ok: false, reason: 'target project menu item not found' };
        const href = selected.href || selected.getAttribute('href') || '';
        const projectId = projectIdFromHref(href) || targetProjectId;
        const name = normalize(selected.innerText || selected.textContent || selected.getAttribute('aria-label')) || 'Project';
        const anchors = Array.from(document.querySelectorAll('a'));
        dispatchFullClick(selected);
        return {
          ok: true,
          project: {
            name,
            url: href ? new URL(href, location.href).toString() : undefined,
            projectId: projectId || undefined,
            documentIndex: anchors.indexOf(selected)
          }
        };
      })()`,
      returnByValue: true,
    });
    const value = result?.value as
      | { ok?: boolean; reason?: string; project?: ChatgptProjectRef }
      | undefined;
    if (value?.ok && value.project) {
      return value.project;
    }
    lastReason = value?.reason ?? lastReason;
    await delay(300);
  }
  throw new Error(lastReason);
}

async function clickConfirmDelete(Runtime: ChromeClient["Runtime"]): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastReason = "delete confirmation button not found";
  while (Date.now() < deadline) {
    const clicked = await clickRuntimeElement(
      Runtime,
      `(() => {
        const visible = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const explicit = Array.from(document.querySelectorAll('[data-testid="delete-conversation-confirm-button"]')).find(visible);
        if (explicit) {
          explicit.click();
          return { ok: true };
        }
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"],[data-radix-portal],body'));
        const scope = dialogs.find((node) => /delete/i.test(node.textContent || '')) || document.body;
        const candidates = Array.from(scope.querySelectorAll('button,[role="button"]')).filter((node) => {
          const text = [node.textContent || '', node.getAttribute?.('aria-label') || '', node.getAttribute?.('title') || ''].join(' ').replace(/\\s+/g, ' ').trim();
          return /\\bdelete\\b/i.test(text);
        }).filter(visible);
        const selected = candidates.find((node) => /^delete$/i.test((node.textContent || '').trim())) || candidates.at(-1);
        if (!selected) return { ok: false, reason: 'delete confirmation button not found' };
        selected.click();
        return { ok: true };
      })()`,
    );
    if (clicked.ok) {
      return;
    }
    lastReason = clicked.reason;
    await delay(300);
  }
  throw new Error(lastReason);
}

async function openProjectRenameEditor(
  Runtime: ChromeClient["Runtime"],
  currentName: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastReason = "project rename menu item not found";
  while (Date.now() < deadline) {
    const clicked = await clickRuntimeElement(
      Runtime,
      `(() => {
        const currentName = ${JSON.stringify(currentName)};
        const visible = (node) => {
          if (!(node instanceof HTMLElement)) return false;
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const input = Array.from(document.querySelectorAll('input[name="title-editor"], input[aria-label="Project name"]')).find(visible);
        if (input) return { ok: true };
        const titleButton = Array.from(document.querySelectorAll('button,[role="button"]')).find((node) => {
          const label = node.getAttribute?.('aria-label') || '';
          const name = node.getAttribute?.('name') || '';
          return visible(node) && (name === 'project-title' || label === 'Edit the title of ' + currentName);
        });
        if (titleButton) {
          titleButton.click();
          return { ok: true };
        }
        const menuItem = Array.from(document.querySelectorAll('[role="menuitem"],button,[role="button"]')).find((node) => {
          const text = String(node.textContent || '').replace(/\\s+/g, ' ').trim();
          return /^rename project$/i.test(text) && visible(node);
        });
        if (menuItem) {
          for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            menuItem.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
          }
          return { ok: true };
        }
        const optionButton = Array.from(document.querySelectorAll('button,[role="button"]')).find((node) => {
          const text = node.getAttribute?.('aria-label') || '';
          return text === 'Open project options for ' + currentName && visible(node);
        });
        if (optionButton) {
          optionButton.click();
          return { ok: false, reason: 'opened project options; waiting for rename item' };
        }
        return { ok: false, reason: 'project rename menu item not found' };
      })()`,
    );
    if (!clicked.ok) {
      lastReason = clicked.reason;
      await delay(300);
      continue;
    }
    const { result } = await Runtime.evaluate({
      expression: `Boolean(Array.from(document.querySelectorAll('input[name="title-editor"], input[aria-label="Project name"]')).find((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }))`,
      returnByValue: true,
    });
    if (result?.value === true) {
      return;
    }
    await delay(300);
  }
  throw new Error(lastReason);
}

async function fillProjectRenameEditor(
  Runtime: ChromeClient["Runtime"],
  newName: string,
): Promise<void> {
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const input = Array.from(document.querySelectorAll('input[name="title-editor"], input[aria-label="Project name"]')).find((node) => {
        if (!(node instanceof HTMLInputElement)) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      if (!input) return { ok: false, reason: 'project title editor not found' };
      input.focus();
      input.select();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) {
        setter.call(input, ${JSON.stringify(newName)});
      } else {
        input.value = ${JSON.stringify(newName)};
      }
      input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: ${JSON.stringify(newName)} }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()`,
    returnByValue: true,
  });
  const value = result?.value as { ok?: boolean; reason?: string } | undefined;
  if (!value?.ok) {
    throw new Error(value?.reason ?? "project rename failed");
  }
}

async function closeProjectDetailsDialog(Runtime: ChromeClient["Runtime"]): Promise<void> {
  await clickRuntimeElement(
    Runtime,
    `(() => {
      const visible = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const dialog = Array.from(document.querySelectorAll('[role="dialog"],body')).find((node) => {
        return /Project name|Instructions|Delete project/.test(node.textContent || '');
      }) || document.body;
      const closeButton = Array.from(dialog.querySelectorAll('button,[role="button"]')).find((node) => {
        return visible(node) && (node.getAttribute?.('aria-label') === 'Close' || /^close$/i.test(node.textContent || ''));
      });
      if (!closeButton) return { ok: false, reason: 'project details close button not found' };
      closeButton.click();
      return { ok: true };
    })()`,
  ).catch(() => undefined);
}

async function clickRuntimeElement(
  Runtime: ChromeClient["Runtime"],
  expression: string,
): Promise<{ ok: boolean; reason: string }> {
  const { result, exceptionDetails } = await Runtime.evaluate({
    expression,
    returnByValue: true,
  });
  if (exceptionDetails) {
    return { ok: false, reason: exceptionDetails.text ?? "click evaluation failed" };
  }
  const value = result?.value as { ok?: boolean; reason?: string } | undefined;
  return {
    ok: Boolean(value?.ok),
    reason: typeof value?.reason === "string" ? value.reason : "element click failed",
  };
}

function conversationIdFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.pathname.match(/\/c\/([^/?#]+)/)?.[1];
  } catch {
    return undefined;
  }
}

function projectIdFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.pathname.match(/\/g\/(g-p-[^/]+)(?:\/project|\/c\/[^/?#]+)?/)?.[1];
  } catch {
    return undefined;
  }
}

function projectNameFromProjectId(projectId: string | undefined): string | undefined {
  const slug = projectId?.match(/^g-p-[0-9a-f]+-(.+)$/i)?.[1];
  if (!slug) return undefined;
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

export const __test__ = {
  buildConversationListExpression,
  buildCurrentProjectExpression,
};
