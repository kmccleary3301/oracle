import fs from "node:fs/promises";
import path from "node:path";
import CDP from "chrome-remote-interface";
import { getOracleHomeDir } from "../oracleHome.js";
import type { BrowserLogger } from "./types.js";

export const DEFAULT_REMOTE_CHROME_MAX_TABS = 4;

interface RemoteChromeTabState {
  endpoints: Record<string, RemoteChromeEndpointState>;
}

interface RemoteChromeEndpointState {
  targets: RemoteChromeManagedTarget[];
}

interface RemoteChromeManagedTarget {
  targetId: string;
  url?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteChromePageTarget {
  id: string;
  type?: string;
  url?: string;
  title?: string;
}

async function closeRemoteChromePageTargetViaBrowser(
  host: string,
  port: number,
  targetId: string,
): Promise<void> {
  const client = await CDP({ host, port });
  try {
    const result = await client.Target.closeTarget({ targetId });
    if (result && "success" in result && result.success === false) {
      throw new Error(`Target.closeTarget reported failure for ${targetId}`);
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

function endpointKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function emptyState(): RemoteChromeTabState {
  return { endpoints: {} };
}

async function loadState(): Promise<RemoteChromeTabState> {
  try {
    const raw = await fs.readFile(resolveStatePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<RemoteChromeTabState>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.endpoints !== "object") {
      return emptyState();
    }
    return {
      endpoints: Object.fromEntries(
        Object.entries(parsed.endpoints).map(([key, value]) => [
          key,
          {
            targets: Array.isArray(value?.targets)
              ? value.targets.flatMap((entry): RemoteChromeManagedTarget[] => {
                  if (!entry || typeof entry !== "object") return [];
                  const targetId =
                    typeof entry.targetId === "string" && entry.targetId.trim()
                      ? entry.targetId.trim()
                      : null;
                  if (!targetId) return [];
                  return [
                    {
                      targetId,
                      url: typeof entry.url === "string" && entry.url ? entry.url : undefined,
                      createdAt:
                        typeof entry.createdAt === "string" && entry.createdAt
                          ? entry.createdAt
                          : new Date(0).toISOString(),
                      updatedAt:
                        typeof entry.updatedAt === "string" && entry.updatedAt
                          ? entry.updatedAt
                          : typeof entry.createdAt === "string" && entry.createdAt
                            ? entry.createdAt
                            : new Date(0).toISOString(),
                    },
                  ];
                })
              : [],
          },
        ]),
      ),
    };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      return emptyState();
    }
    throw error;
  }
}

async function saveState(state: RemoteChromeTabState): Promise<void> {
  const statePath = resolveStatePath();
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function resolveStatePath(): string {
  return path.join(getOracleHomeDir(), "remote-chrome-tabs.json");
}

function upsertTarget(
  targets: RemoteChromeManagedTarget[],
  targetId: string,
  url?: string,
): RemoteChromeManagedTarget[] {
  const now = new Date().toISOString();
  const existing = targets.find((entry) => entry.targetId === targetId);
  if (existing) {
    return targets.map((entry) =>
      entry.targetId === targetId
        ? { ...entry, url: url ?? entry.url, updatedAt: now }
        : entry,
    );
  }
  return [...targets, { targetId, url, createdAt: now, updatedAt: now }];
}

export async function recordRemoteChromeTarget(
  host: string,
  port: number,
  targetId: string,
  url?: string,
): Promise<void> {
  const state = await loadState();
  const key = endpointKey(host, port);
  const endpoint = state.endpoints[key] ?? { targets: [] };
  endpoint.targets = upsertTarget(endpoint.targets, targetId, url);
  state.endpoints[key] = endpoint;
  await saveState(state);
}

export async function forgetRemoteChromeTarget(
  host: string,
  port: number,
  targetId: string,
): Promise<void> {
  const state = await loadState();
  const key = endpointKey(host, port);
  const endpoint = state.endpoints[key];
  if (!endpoint) return;
  endpoint.targets = endpoint.targets.filter((entry) => entry.targetId !== targetId);
  if (endpoint.targets.length === 0) {
    delete state.endpoints[key];
  } else {
    state.endpoints[key] = endpoint;
  }
  await saveState(state);
}

export async function pruneRemoteChromeTargets(
  host: string,
  port: number,
  logger: BrowserLogger,
  options: {
    maxTabs?: number;
    reserveSlots?: number;
    includeNonChatgpt?: boolean;
  } = {},
): Promise<{ closedTargetIds: string[]; trackedCount: number; livePageCount: number }> {
  const maxTabs = Math.max(1, options.maxTabs ?? DEFAULT_REMOTE_CHROME_MAX_TABS);
  const reserveSlots = Math.max(0, options.reserveSlots ?? 0);
  const state = await loadState();
  const key = endpointKey(host, port);
  const endpoint = state.endpoints[key] ?? { targets: [] };
  const targets = await CDP.List({ host, port });
  const livePages = targets.filter((target) => target.type === "page");
  const livePageIds = new Set(livePages.map((target) => target.id));
  const tracked = endpoint.targets
    .filter((entry) => livePageIds.has(entry.targetId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const trackedById = new Map(tracked.map((entry) => [entry.targetId, entry]));
  const closableLivePages = livePages.filter((target) => {
    if (options.includeNonChatgpt) return true;
    const normalizedUrl = String(target.url || trackedById.get(target.id)?.url || "");
    return normalizedUrl.startsWith("https://chatgpt.com/") || normalizedUrl === "about:blank";
  });
  const trackedClosable = tracked.flatMap((entry): RemoteChromePageTarget[] => {
    const live = livePages.find((target) => target.id === entry.targetId);
    if (!live) return [];
    if (!closableLivePages.some((candidate) => candidate.id === live.id)) return [];
    return [live];
  });
  const closable: RemoteChromePageTarget[] = [
    ...trackedClosable,
    ...closableLivePages.filter((target) => !trackedById.has(target.id)),
  ];
  const budget = Math.max(0, maxTabs - reserveSlots);
  const overflow = Math.max(0, closable.length - budget);
  const toClose: RemoteChromePageTarget[] = closable.slice(0, overflow);
  const closedTargetIds: string[] = [];

  for (const entry of toClose) {
    try {
      await closeRemoteChromePageTargetViaBrowser(host, port, entry.id);
      closedTargetIds.push(entry.id);
      logger(`[tabs] pruned remote Chrome tab ${entry.id} to enforce max ${maxTabs} tabs`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`[tabs] failed to prune remote Chrome tab ${entry.id}: ${message}`);
    }
  }

  endpoint.targets = tracked.filter((entry) => !closedTargetIds.includes(entry.targetId));
  if (endpoint.targets.length === 0) {
    delete state.endpoints[key];
  } else {
    state.endpoints[key] = endpoint;
  }
  await saveState(state);

  return {
    closedTargetIds,
    trackedCount: tracked.length,
    livePageCount: livePages.length,
  };
}

export async function closeRemoteChromePageTarget(
  host: string,
  port: number,
  targetId: string,
): Promise<void> {
  try {
    await closeRemoteChromePageTargetViaBrowser(host, port, targetId);
  } catch {
    await CDP.Close({ host, port, id: targetId });
  }
}

export const __test__ = {
  endpointKey,
};
