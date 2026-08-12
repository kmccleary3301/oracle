import type {
  BrowserResponseCitation,
  BrowserResponseCodeBlock,
  BrowserResponseFileRef,
  BrowserResponseImageRef,
  BrowserResponseProvenance,
  BrowserResponseTable,
} from "../types.js";

export interface ChatgptResponseOutputInput {
  html?: string | null;
  turnId?: string | null;
  messageId?: string | null;
  turnIndex?: number;
  conversationUrl?: string | null;
  conversationId?: string | null;
  modelSelection?: BrowserResponseProvenance["modelSelection"];
}
export interface ChatgptResponseOutput {
  sanitizedHtml: string;
  citations: BrowserResponseCitation[];
  codeBlocks: BrowserResponseCodeBlock[];
  tables: BrowserResponseTable[];
  fileRefs: BrowserResponseFileRef[];
  imageRefs: BrowserResponseImageRef[];
  provenance: BrowserResponseProvenance;
}

function decodeHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .trim();
}

function attribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match?.[1];
}

export function sanitizeAssistantHtml(html: string | null | undefined): string {
  return (html ?? "")
    .replace(/<(script|style|form|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|form|iframe|object|embed)\b[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(?:style|srcdoc)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, "")
    .trim();
}
function context<T extends object>(
  value: T,
  input: ChatgptResponseOutputInput,
): T & { turnId: string | null; messageId: string | null; turnIndex?: number } {
  return {
    ...value,
    turnId: input.turnId ?? null,
    messageId: input.messageId ?? null,
    ...(input.turnIndex === undefined ? {} : { turnIndex: input.turnIndex }),
  };
}

export function extractChatgptResponseOutput(
  input: ChatgptResponseOutputInput,
): ChatgptResponseOutput {
  const sanitizedHtml = sanitizeAssistantHtml(input.html);
  const citations: BrowserResponseCitation[] = [];
  const fileRefs: BrowserResponseFileRef[] = [];
  const imageRefs: BrowserResponseImageRef[] = [];
  const codeBlocks: BrowserResponseCodeBlock[] = [];
  const tables: BrowserResponseTable[] = [];

  for (const match of sanitizedHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attrs = match[1] ?? "";
    const href = attribute(attrs, "href");
    if (!href) continue;
    const text = decodeHtml(match[2] ?? "");
    const title = attribute(attrs, "title");
    citations.push(context({ href, text, ...(title ? { title } : {}) }, input));
    if (/\.(?:txt|md|json|csv|zip|pdf|png|jpe?g|webp|gif|svg)(?:[?#]|$)/i.test(href)) {
      fileRefs.push(context({ href, name: text || undefined }, input));
    }
  }

  for (const match of sanitizedHtml.matchAll(
    /<pre\b[^>]*>\s*<code\b([^>]*)>([\s\S]*?)<\/code\s*>\s*<\/pre\s*>/gi,
  )) {
    const className = attribute(match[1] ?? "", "class");
    const language = className?.match(/(?:language|lang)-([\w+-]+)/i)?.[1];
    codeBlocks.push(
      context({ code: decodeHtml(match[2] ?? ""), ...(language ? { language } : {}) }, input),
    );
  }

  for (const match of sanitizedHtml.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)) {
    const rows: string[][] = [];
    for (const row of (match[1] ?? "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
      const cells = Array.from(
        (row[1] ?? "").matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi),
      ).map((cell) => decodeHtml(cell[1] ?? ""));
      if (cells.length > 0) rows.push(cells);
    }
    const headers = rows[0] ?? [];
    tables.push(context({ headers, rows: rows.slice(1) }, input));
  }

  for (const match of sanitizedHtml.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = match[1] ?? "";
    const src = attribute(attrs, "src");
    if (!src) continue;
    const alt = attribute(attrs, "alt");
    const title = attribute(attrs, "title");
    imageRefs.push(context({ src, ...(alt ? { alt } : {}), ...(title ? { title } : {}) }, input));
  }

  return {
    sanitizedHtml,
    citations,
    codeBlocks,
    tables,
    fileRefs,
    imageRefs,
    provenance: {
      source: "chatgpt-dom",
      capturedAt: new Date().toISOString(),
      ...(input.conversationUrl ? { conversationUrl: input.conversationUrl } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      turnId: input.turnId ?? null,
      messageId: input.messageId ?? null,
      ...(input.turnIndex === undefined ? {} : { turnIndex: input.turnIndex }),
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    },
  };
}
