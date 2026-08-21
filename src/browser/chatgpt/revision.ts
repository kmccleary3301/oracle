import { createHash } from "node:crypto";
import type { ChromeClient } from "../types.js";
import { CONVERSATION_TURN_SELECTOR } from "../constants.js";
import { captureConversationTurnMarkdowns } from "../pageActions.js";
import type { ChatgptConversationSnapshot, ChatgptConversationTurnSnapshot } from "./types.js";

export const CHATGPT_CONVERSATION_REVISION_ALGORITHM = "sha256" as const;
export const CHATGPT_CONVERSATION_REVISION_VERSION = 1 as const;

export type ChatgptConversationDivergencePolicy = "fail" | "append-latest" | "branch" | "new-chat";

export interface ChatgptConversationRevisionTurn {
  index: number;
  role: ChatgptConversationTurnSnapshot["role"];
  turnId: string | null;
  messageId: string | null;
  textHash: string;
}

/**
 * A privacy-preserving fingerprint of the observable conversation head.
 * Raw turn text is intentionally not retained in this value.
 */
export interface ChatgptConversationRevision {
  version: typeof CHATGPT_CONVERSATION_REVISION_VERSION;
  algorithm: typeof CHATGPT_CONVERSATION_REVISION_ALGORITHM;
  hash: string;
  conversationUrl: string;
  conversationId: string | null;
  turns: ChatgptConversationRevisionTurn[];
}

export interface ChatgptConversationRevisionObservation {
  conversationUrl?: string | null;
  conversationId?: string | null;
  turns: Array<{
    index?: number;
    role?: ChatgptConversationTurnSnapshot["role"];
    turnId?: string | null;
    messageId?: string | null;
    text?: string | null;
  }>;
}

const EMPTY_ID = null;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeString(value: string | null | undefined): string {
  return typeof value === "string" ? value : "";
}

function conversationIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/c\/([^/]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function canonicalConversationUrl(url: string | null | undefined): string {
  const normalized = normalizeString(url).trim();
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return normalized;
  }
}

function normalizeTurn(
  turn: ChatgptConversationRevisionObservation["turns"][number],
  fallbackIndex: number,
): ChatgptConversationRevisionTurn {
  const index = Number.isFinite(turn.index)
    ? Math.max(0, Math.floor(turn.index as number))
    : fallbackIndex;
  const role =
    turn.role === "user" || turn.role === "assistant" || turn.role === "unknown"
      ? turn.role
      : "unknown";
  const turnId = normalizeString(turn.turnId).trim() || EMPTY_ID;
  const messageId = normalizeString(turn.messageId).trim() || EMPTY_ID;
  const text = normalizeString(turn.text);
  return {
    index,
    role,
    turnId,
    messageId,
    textHash: sha256(text),
  };
}

export function computeChatgptConversationRevision(
  snapshot: ChatgptConversationSnapshot | ChatgptConversationRevisionObservation,
  conversationUrl?: string | null,
): ChatgptConversationRevision {
  const snapshotPage = "page" in snapshot ? snapshot.page : undefined;
  const resolvedUrl = canonicalConversationUrl(
    conversationUrl ??
      snapshotPage?.href ??
      ("conversationUrl" in snapshot ? snapshot.conversationUrl : ""),
  );
  const explicitConversationId =
    "conversationId" in snapshot ? snapshot.conversationId : snapshotPage?.conversationId;
  const conversationId =
    normalizeString(explicitConversationId).trim() || conversationIdFromUrl(resolvedUrl);
  const turns = snapshot.turns.map((turn, index) => normalizeTurn(turn, index));
  const material = JSON.stringify({
    version: CHATGPT_CONVERSATION_REVISION_VERSION,
    algorithm: CHATGPT_CONVERSATION_REVISION_ALGORITHM,
    conversationUrl: resolvedUrl,
    conversationId: conversationId || EMPTY_ID,
    turns,
  });
  return {
    version: CHATGPT_CONVERSATION_REVISION_VERSION,
    algorithm: CHATGPT_CONVERSATION_REVISION_ALGORITHM,
    hash: sha256(material),
    conversationUrl: resolvedUrl,
    conversationId: conversationId || EMPTY_ID,
    turns,
  };
}

export function revisionsEqual(
  expected: ChatgptConversationRevision,
  observed: ChatgptConversationRevision,
): boolean {
  return expected.hash === observed.hash;
}

/** Build a browser expression that observes only turn identity, role, and text. */
export function buildChatgptConversationRevisionExpression(): string {
  const selector = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  return `(() => {
    const turns = Array.from(document.querySelectorAll(${selector})).map((turn, index) => {
      const attrs = [
        turn.getAttribute('data-message-author-role'),
        turn.getAttribute('data-turn'),
        turn.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role'),
        turn.querySelector('[data-turn]')?.getAttribute('data-turn')
      ].filter(Boolean).join(' ').toLowerCase();
      const text = (turn.innerText || turn.textContent || '').replace(/\\s+/g, ' ').trim();
      const role = attrs.includes('user')
        ? 'user'
        : attrs.includes('assistant')
          ? 'assistant'
          : (/^you said[:\\s]/i.test(text) ? 'user' : (/^chatgpt said[:\\s]/i.test(text) ? 'assistant' : 'unknown'));
      return {
        index,
        role,
        turnId: turn.getAttribute('data-testid') || turn.id || null,
        messageId: turn.getAttribute('data-message-id') || null,
        text,
      };
    });
    return { conversationUrl: location.href, conversationId: (() => {
      const match = location.pathname.match(/\\/c\\/([^/]+)/i);
      return match?.[1] || null;
    })(), turns };
  })()`;
}

export async function readChatgptConversationRevisionFromRuntime(
  Runtime: ChromeClient["Runtime"],
  conversationUrl?: string | null,
): Promise<ChatgptConversationRevision> {
  const { result } = await Runtime.evaluate({
    expression: buildChatgptConversationRevisionExpression(),
    returnByValue: true,
  });
  const value = result?.value;
  const observation: ChatgptConversationRevisionObservation =
    value && typeof value === "object"
      ? {
          conversationUrl:
            typeof (value as { conversationUrl?: unknown }).conversationUrl === "string"
              ? (value as { conversationUrl: string }).conversationUrl
              : conversationUrl,
          conversationId:
            typeof (value as { conversationId?: unknown }).conversationId === "string"
              ? (value as { conversationId: string }).conversationId
              : null,
          turns: Array.isArray((value as { turns?: unknown }).turns)
            ? ((value as { turns: ChatgptConversationRevisionObservation["turns"] }).turns ?? [])
            : [],
        }
      : { conversationUrl, turns: [] };
  const copiedMarkdowns = await captureConversationTurnMarkdowns(Runtime).catch(
    () => new Map<number, string>(),
  );
  return computeChatgptConversationRevision(
    {
      ...observation,
      turns: observation.turns.map((turn, index) => ({
        ...turn,
        text: copiedMarkdowns.get(index) ?? turn.text,
      })),
    },
    conversationUrl,
  );
}
