import type { ApprovalChallenge } from "../approvalToken.js";
import type {
  BrowserResponseCitation,
  BrowserResponseCodeBlock,
  BrowserResponseFileRef,
  BrowserResponseImageRef,
  BrowserResponseProvenance,
  BrowserResponseTable,
} from "../types.js";

export const RESEARCH_STATES = [
  "unsupported",
  "conflict",
  "queued",
  "submitted",
  "planning",
  "waiting_for_plan_approval",
  "running",
  "waiting_for_user_input",
  "waiting_for_confirmation",
  "completed",
  "interrupted",
  "requires_action",
  "disconnected",
] as const;
export type ResearchState = (typeof RESEARCH_STATES)[number];

export interface ResearchSourceAllowlist {
  /** Exact host names or URL origins to permit. */
  sites?: string[];
  /** ChatGPT connector/application labels to permit. */
  apps?: string[];
}

export interface ResearchProgress {
  state: ResearchState;
  phase?: string | null;
  label?: string | null;
  percent?: number | null;
  elapsedMs?: number | null;
  updatedAt?: string | null;
}

export interface ResearchPlanSnapshot {
  revisionHash: string | null;
  summary: string | null;
  action: string | null;
  sites: string[];
  apps: string[];
  consequential: boolean;
  externalWrite: boolean;
  unknown: boolean;
  approvePoint?: { x: number; y: number } | null;
  editPoint?: { x: number; y: number } | null;
}

export interface ResearchTurnSnapshot {
  id: string | null;
  revisionHash?: string | null;
  active: boolean;
}

export interface ResearchUserQuestionSnapshot {
  id: string | null;
  question: string | null;
  answerPoint?: { x: number; y: number } | null;
}

export interface ResearchSnapshot {
  url: string;
  conversationId: string | null;
  mode: "deep-research" | "chat" | "unknown";
  controls: {
    deepResearch: boolean;
    deepResearchSelected: boolean;
    stop: boolean;
    plan: boolean;
  };
  state: ResearchState;
  turn: ResearchTurnSnapshot | null;
  plan: ResearchPlanSnapshot | null;
  userQuestion: ResearchUserQuestionSnapshot | null;
  progress: ResearchProgress | null;
  reason?: string;
}

export interface ResearchReportArtifact {
  format: "markdown" | "docx" | "pdf";
  downloadedPath: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  conversationUrl?: string | null;
  conversationId?: string | null;
  turnId?: string | null;
  messageId?: string | null;
}

export interface ResearchAnswer {
  text: string;
  markdown: string;
  html?: string;
  citations: BrowserResponseCitation[];
  codeBlocks: BrowserResponseCodeBlock[];
  tables: BrowserResponseTable[];
  fileRefs: BrowserResponseFileRef[];
  imageRefs: BrowserResponseImageRef[];
  provenance?: BrowserResponseProvenance;
  turnId?: string | null;
  messageId?: string | null;
}

export interface ResearchResult {
  state: ResearchState;
  conversationUrl: string | null;
  conversationId: string | null;
  turnId?: string | null;
  messageId?: string | null;
  plan?: ResearchPlanSnapshot | null;
  progress?: ResearchProgress | null;
  answer?: ResearchAnswer;
  reports?: ResearchReportArtifact[];
  approvalChallenge?: ApprovalChallenge | null;
  dryRun?: boolean;
  verified?: boolean;
  reason?: string;
  retryAfterMs?: number;
  recovery?: {
    recoverable: boolean;
    retryAfterMs?: number;
    guidance?: string;
  };
}
export interface ResearchErrorClassification {
  code:
    | "mode-unavailable"
    | "source-restriction"
    | "plan-revision-conflict"
    | "approval-grant-mismatch"
    | "rate-limited"
    | "disconnected"
    | "unknown";
  retryable: boolean;
  retryAfterMs?: number;
  message: string;
}
