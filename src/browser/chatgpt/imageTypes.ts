import type { ApprovalChallenge, ApprovalGrantAuthority } from "../approvalToken.js";
import type { ChatgptDownloadedImageArtifact, ChatgptGeneratedImage } from "./types.js";

export type ChatgptImageOperation =
  | "generate"
  | "edit"
  | "get"
  | "download"
  | "library_list"
  | "library_get"
  | "undo"
  | "redo"
  | "interrupt";

export type ChatgptImageLifecycleState =
  | "queued"
  | "running"
  | "partial"
  | "completed"
  | "requires_action"
  | "unsupported"
  | "interrupted"
  | "rate_limited"
  | "disconnected"
  | "error";

export type ChatgptImageFailureCode =
  | "mode_unavailable"
  | "mode_unverified"
  | "login_required"
  | "no_image_artifacts"
  | "target_not_found"
  | "target_ambiguous"
  | "approval_required"
  | "stale_target"
  | "rate_limit"
  | "disconnect"
  | "interrupted"
  | "browser_error"
  | "unknown";

/** Capability evidence intentionally contains only public UI labels and booleans. */
export interface ChatgptImageModeEvidence {
  supported: boolean;
  verified: boolean;
  selectedMode: string | null;
  availableModes: string[];
  pageIdentity: "chatgpt_app" | "auth" | "challenge" | "other" | "unknown";
  loginLikely: boolean;
  source: "dom" | "capability" | "caller";
  reason?: string;
}

export interface ChatgptImageAspectMetadata {
  requested?: string;
  actual?: string;
}

export interface ChatgptImageCountMetadata {
  requested?: number;
  produced: number;
}

export interface ChatgptImageOrigin {
  conversationUrl?: string;
  conversationId?: string;
  turnId?: string | null;
  messageId?: string | null;
  turnIndex?: number | null;
}

/** Safe image output; DOM alt/title/class metadata is deliberately not carried forward. */
export type ChatgptImageOutput = Omit<ChatgptGeneratedImage, "domRecords"> & {
  outputIndex: number;
  aspect?: ChatgptImageAspectMetadata;
  origin?: ChatgptImageOrigin;
};

export type ChatgptImageArtifact = Omit<
  ChatgptDownloadedImageArtifact,
  "fileId" | "sourceUrl" | "variantIndex"
> & {
  fileId: string;
  sourceUrl: string;
  variantIndex: number;
  origin?: ChatgptImageOrigin;
  quality: "full";
};

export interface ChatgptImageTarget {
  fileId: string;
  turnId?: string | null;
  messageId?: string | null;
  revisionHash?: string;
}

export interface ChatgptImageLibraryEntry extends ChatgptImageOutput {
  mimeType?: string;
  byteSize?: number;
  sha256?: string;
  createdAt?: string;
}

export interface ChatgptImageLibraryResult {
  state: Extract<ChatgptImageLifecycleState, "completed" | "partial">;
  entries: ChatgptImageLibraryEntry[];
  warnings: string[];
  capability?: ChatgptImageModeEvidence;
}

export interface ChatgptImageFailure {
  code: ChatgptImageFailureCode;
  message: string;
  retryable: boolean;
  capability?: ChatgptImageModeEvidence;
}

export interface ChatgptImageOperationBase {
  operation: ChatgptImageOperation;
  state: ChatgptImageLifecycleState;
  capability?: ChatgptImageModeEvidence;
  approvalChallenge?: ApprovalChallenge;
  warnings: string[];
  failure?: ChatgptImageFailure;
  jobId?: string;
}

export interface ChatgptImageOperationResult<T> extends ChatgptImageOperationBase {
  value?: T;
  outputs?: ChatgptImageOutput[];
  artifacts?: ChatgptImageArtifact[];
  origin?: ChatgptImageOrigin;
}

export interface ChatgptImageHistoryEntry {
  target: ChatgptImageTarget;
  revisionHash: string;
  outputs: ChatgptImageOutput[];
  createdAt: string;
}

export interface ChatgptImageHistory {
  entries: ChatgptImageHistoryEntry[];
  cursor: number;
}

export interface ChatgptImageInterruptResult {
  operation: "interrupt";
  state: "interrupted" | "requires_action" | "completed";
  target: ChatgptImageTarget;
  stopped: boolean;
  approvalChallenge?: ApprovalChallenge;
  reason?: string;
}

export interface ChatgptImageApprovalOptions {
  approvalChallenge?: ApprovalChallenge;
  approvalGrant?: string;
  approvalAuthority?: ApprovalGrantAuthority;
}

export interface ChatgptImageSourceSelection {
  status: "selected" | "requires_action" | "not_found";
  image?: ChatgptImageOutput;
  candidates: ChatgptImageOutput[];
  reason?: string;
}
