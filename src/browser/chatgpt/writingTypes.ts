import type { ApprovalChallenge, ApprovalGrantAuthority } from "../approvalToken.js";
import type {
  BrowserResponseCodeBlock,
  BrowserResponseProvenance,
  BrowserResponseTable,
} from "../types.js";
import type { ChatgptResponseOutput } from "../actions/responseOutput.js";

export type WritingBlockKind = "prose" | "code" | "table";

export type WritingOperation =
  | "writing.get"
  | "writing.edit"
  | "writing.preview"
  | "writing.run"
  | "writing.stop"
  | "writing.export"
  | "codeBlock.list"
  | "codeBlock.get"
  | "codeBlock.copy"
  | "codeBlock.save";

export type WritingStatus =
  | "ok"
  | "preview"
  | "requires_action"
  | "unsupported"
  | "disconnected"
  | "conflict"
  | "not_found"
  | "stopped";

export interface WritingCapabilityEvidence {
  controls: {
    writing: boolean;
    edit: boolean;
    preview: boolean;
    run: boolean;
    stop: boolean;
    export: boolean;
    codeBlock: boolean;
  };
  supported: boolean;
  /** Stable reason codes only; never includes page text. */
  reason?:
    | "missing-controls"
    | "unknown-controls"
    | "disconnected"
    | "conversation-mismatch"
    | "revision-mismatch"
    | "block-mismatch"
    | "run-mismatch"
    | "unsupported-action";
}

export interface WritingBlockIdentity {
  blockId: string;
  conversationId: string;
  turnId: string;
  messageId: string;
  index: number;
  language: string | null;
  revisionHash: string;
}

export interface WritingProseBlock extends WritingBlockIdentity {
  kind: "prose";
  text: string;
  html?: string;
  provenance: BrowserResponseProvenance;
}

export interface WritingCodeBlock extends WritingBlockIdentity {
  kind: "code";
  code: string;
  language: string | null;
  provenance: BrowserResponseProvenance;
}

export interface WritingTableBlock extends WritingBlockIdentity {
  kind: "table";
  headers: string[];
  rows: string[][];
  provenance: BrowserResponseProvenance;
}

export type WritingBlock = WritingProseBlock | WritingCodeBlock | WritingTableBlock;

export interface ChatgptWritingMessage {
  conversationId: string;
  turnId: string;
  messageId: string;
  index: number;
  html: string;
  revisionHash: string;
  responseOutput?: ChatgptResponseOutput;
  blocks: WritingBlock[];
}

export interface ChatgptWritingSnapshot {
  status: WritingStatus;
  conversationId: string | null;
  conversationUrl?: string | null;
  turnId: string | null;
  messageId: string | null;
  revisionHash: string | null;
  blocks: WritingBlock[];
  messages?: ChatgptWritingMessage[];
  responseOutput?: ChatgptResponseOutput;
  provenance?: BrowserResponseProvenance;
  capability: WritingCapabilityEvidence;
  activeRun?: WritingRun | null;
  reason?: string;
}

export interface WritingPlan {
  operation: WritingOperation;
  target: WritingBlockIdentity;
  revisionHash: string;
  consequential: boolean;
  externalWrite: boolean;
  unknown: boolean;
  summary?: string;
}

export interface WritingRun {
  runId: string;
  status: "queued" | "running" | "completed" | "stopped" | "requires_action";
  target: WritingBlockIdentity;
  revisionHash: string;
}

export interface WritingArtifact {
  path?: string;
  filename?: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  bytes: Uint8Array;
  conversationId: string;
  turnId: string;
  messageId: string;
  blockId: string;
  provenance: BrowserResponseProvenance;
}

export interface WritingActionResult {
  status: WritingStatus;
  operation: WritingOperation;
  conversationId: string | null;
  turnId: string | null;
  messageId: string | null;
  blockId?: string | null;
  revisionHash: string | null;
  blocks?: WritingBlock[];
  block?: WritingBlock | null;
  codeBlocks?: WritingCodeBlock[];
  run?: WritingRun | null;
  artifact?: WritingArtifact;
  plan?: WritingPlan;
  dryRun: boolean;
  approvalChallenge: ApprovalChallenge | null;
  capability: WritingCapabilityEvidence;
  provenance?: BrowserResponseProvenance;
  reason?: string;
}

export interface WritingGetInput {
  conversationId: string;
  turnId?: string;
  messageId?: string;
  revisionHash?: string;
}

export interface WritingTargetInput {
  conversationId: string;
  turnId: string;
  messageId: string;
  blockId: string;
  revisionHash: string;
}

export interface WritingEditInput extends WritingTargetInput {
  content: string;
  dryRun?: boolean;
  approvalChallenge?: ApprovalChallenge;
  approvalGrant?: string;
}

export interface WritingPreviewInput extends WritingTargetInput {
  content?: string;
}

export interface WritingRunInput extends WritingTargetInput {
  dryRun?: boolean;
  approvalChallenge?: ApprovalChallenge;
  approvalGrant?: string;
}

export interface WritingStopInput extends WritingTargetInput {
  runId: string;
}

export interface WritingExportInput extends WritingTargetInput {
  dryRun?: boolean;
  approvalChallenge?: ApprovalChallenge;
  approvalGrant?: string;
  outputPath?: string;
  mimeType?: string;
}

export interface CodeBlockListInput extends WritingGetInput {}
export interface CodeBlockGetInput extends WritingTargetInput {}
export interface CodeBlockCopyInput extends WritingTargetInput {}
export interface CodeBlockSaveInput extends WritingExportInput {}

export type WritingOperationInput =
  | WritingGetInput
  | WritingEditInput
  | WritingPreviewInput
  | WritingRunInput
  | WritingStopInput
  | WritingExportInput
  | CodeBlockListInput
  | CodeBlockGetInput
  | CodeBlockCopyInput
  | CodeBlockSaveInput;

export interface WritingBrowserDriver {
  get(input: WritingGetInput): Promise<ChatgptWritingSnapshot>;
  edit?(input: WritingEditInput): Promise<ChatgptWritingSnapshot | WritingBlock>;
  preview?(input: WritingPreviewInput): Promise<WritingBlock | ChatgptWritingSnapshot>;
  run?(input: WritingRunInput): Promise<WritingRun | ChatgptWritingSnapshot>;
  stop?(input: WritingStopInput): Promise<WritingRun | ChatgptWritingSnapshot>;
  export?(input: WritingExportInput): Promise<WritingArtifact | Uint8Array | string>;
}

export interface WritingRuntimeOptions {
  Runtime: {
    evaluate(input: { expression: string; returnByValue?: boolean }): Promise<{
      result?: { value?: unknown; description?: string; type?: string };
    }>;
  };
  timeoutMs?: number;
  approvalAuthority?: ApprovalGrantAuthority;
  principal?: string;
  session?: string;
}

export interface WritingExtractionInput {
  html?: string | null;
  conversationUrl?: string | null;
  conversationId?: string | null;
  turnId?: string | null;
  messageId?: string | null;
  turnIndex?: number;
  revisionHash?: string | null;
}

export interface WritingExtractionResult {
  blocks: WritingBlock[];
  responseOutput: ChatgptResponseOutput;
  provenance: BrowserResponseProvenance;
  revisionHash: string;
}

export type { BrowserResponseCodeBlock, BrowserResponseTable };
