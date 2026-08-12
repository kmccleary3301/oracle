export type {
  ChatgptConversationDivergencePolicy,
  ChatgptConversationRevision,
  ChatgptConversationRevisionObservation,
  ChatgptConversationRevisionTurn,
} from "./revision.js";
export type {
  BrowserResponseCitation,
  BrowserResponseCodeBlock,
  BrowserResponseFileRef,
  BrowserResponseImageRef,
  BrowserResponseProvenance,
  BrowserResponseTable,
} from "../types.js";
import type {
  BrowserResponseCitation,
  BrowserResponseCodeBlock,
  BrowserResponseFileRef,
  BrowserResponseImageRef,
  BrowserResponseProvenance,
  BrowserResponseTable,
} from "../types.js";

import type { ThinkingTimeSelectionResult } from "../actions/thinkingTime.js";
import type { ThinkingControlInfo, ThinkingControlsDiagnostics } from "../actions/thinkingTime.js";

export interface ChatgptPageSnapshot {
  href: string;
  title: string;
  readyState: string;
  hasComposer: boolean;
  loginLikely: boolean;
  imageNodeCount: number;
  generatedImageNodeCount: number;
  uniqueGeneratedImageCount: number;
  conversationId?: string;
  hasModelMenu?: boolean;
  modelMenuLabel?: string;
  hasFileUploadControl?: boolean;
  hasPhotoUploadControl?: boolean;
  hasComposerPlusButton?: boolean;
}

export interface ChatgptImageDomRecord {
  fileId: string;
  src: string;
  alt?: string;
  turnId?: string | null;
  messageId?: string | null;
  turnIndex?: number | null;
  renderedWidth: number;
  renderedHeight: number;
  area: number;
  documentIndex: number;
  isThumbnail: boolean;
  role?: string | null;
  ancestorSummary?: string[];
}

export interface ChatgptGeneratedImage {
  fileId: string;
  sourceUrl: string;
  turnId?: string | null;
  messageId?: string | null;
  turnIndex?: number | null;
  variantIndex: number;
  renderedWidth: number;
  renderedHeight: number;
  isThumbnail: boolean;
  duplicateNodeCount: number;
  domRecords: ChatgptImageDomRecord[];
}

export interface ChatgptDownloadedImageArtifact {
  fileId: string;
  sourceUrl: string;
  downloadedPath: string;
  mimeType?: string;
  width?: number;
  height?: number;
  byteSize: number;
  sha256: string;
  variantIndex: number;
  downloadMethod: "browser-fetch";
}

export interface ChatgptImageExtractionResult {
  page: ChatgptPageSnapshot;
  images: ChatgptGeneratedImage[];
  artifacts: ChatgptDownloadedImageArtifact[];
  outputDir?: string;
  warnings: string[];
}

export interface ChatgptSandboxArtifactRef {
  label: string;
  turnIndex: number;
  turnId?: string | null;
  messageId?: string | null;
  documentIndex: number;
  artifactFreshness?: "messageId" | "turnIndex" | "baseline-diff" | "unverified";
}

export interface ChatgptDownloadedSandboxArtifact {
  label: string;
  turnIndex: number;
  turnId?: string | null;
  messageId?: string | null;
  documentIndex: number;
  artifactFreshness?: "messageId" | "turnIndex" | "baseline-diff" | "unverified";
  sandboxPath?: string;
  fileId?: string;
  fileName: string;
  downloadedPath: string;
  mimeType?: string;
  byteSize: number;
  sha256: string;
  downloadMethod: "browser-fetch";
}

export interface ChatgptSandboxArtifactExtractionResult {
  page: ChatgptPageSnapshot;
  sandboxArtifacts: ChatgptSandboxArtifactRef[];
  downloadedArtifacts: ChatgptDownloadedSandboxArtifact[];
  outputDir?: string;
  warnings: string[];
}

export interface ChatgptConversationTurnSnapshot {
  index: number;
  role: "user" | "assistant" | "unknown";
  turnId?: string | null;
  messageId?: string | null;
  text: string;
  textPreview: string;
  generatedImageFileIds: string[];
  attachmentLabels: string[];
  sandboxArtifactLabels: string[];
}

export interface ChatgptConversationSnapshot {
  page: ChatgptPageSnapshot;
  turns: ChatgptConversationTurnSnapshot[];
  generatedImages: ChatgptGeneratedImage[];
  sandboxArtifacts: ChatgptSandboxArtifactRef[];
  latestAssistantTurn?: ChatgptConversationTurnSnapshot;
  latestUserTurn?: ChatgptConversationTurnSnapshot;
  warnings: string[];
}

export interface ChatgptBrowserStatus {
  remoteChrome: { host: string; port: number };
  page: ChatgptPageSnapshot;
  conversation?: ChatgptConversationSnapshot;
  status: "ok" | "needs_login" | "unavailable";
  warnings: string[];
}

export interface ChatgptAttachmentProbeResult {
  remoteChrome: { host: string; port: number };
  page: ChatgptPageSnapshot;
  plannedAttachments: Array<{
    path: string;
    displayPath: string;
    sizeBytes?: number;
  }>;
  uploadedNames: string[];
  cleared: boolean;
  warnings: string[];
}

export interface ChatgptControlsInspectionResult {
  page: ChatgptPageSnapshot;
  modelMenuLabel?: string;
  availableModelLabels: string[];
  thinkingControls: ThinkingControlInfo[];
  thinkingDiagnostics: ThinkingControlsDiagnostics;
  warnings: string[];
}
export type ChatgptCapabilityProbeStatus =
  | "ok"
  | "login_required"
  | "challenge_required"
  | "unknown"
  | "unavailable";

export type ChatgptCapabilityPageIdentity =
  | "chatgpt_app"
  | "auth"
  | "challenge"
  | "other"
  | "unknown";

export type ChatgptCapabilityLoginState =
  | "logged_in"
  | "login_required"
  | "challenge_required"
  | "unknown";

export type ChatgptCapabilityChallenge = "none" | "cloudflare" | "account_security" | "unknown";

export type ChatgptCapabilityFailureCode =
  | "configuration_missing"
  | "connection_failed"
  | "navigation_failed"
  | "evaluation_failed"
  | "invalid_observation"
  | "unknown";

export interface ChatgptCapabilityProbeResult {
  schemaVersion: 1;
  status: ChatgptCapabilityProbeStatus;
  capturedAt: string;
  adapterVersion: string;
  remoteChrome: { host: string; port: number } | null;
  page: {
    identityClass: ChatgptCapabilityPageIdentity;
    readyState: "loading" | "interactive" | "complete" | "unknown";
    locale: string | null;
  };
  auth: {
    state: ChatgptCapabilityLoginState;
    challenge: ChatgptCapabilityChallenge;
  };
  controls: {
    modes: string[];
    models: string[];
    effort: string[];
    uploads: {
      file: boolean;
      image: boolean;
      multiple: boolean;
    };
  };
  indicators: {
    project: boolean;
    projectSources: boolean;
    work: boolean;
    research: boolean;
    tools: string[];
  };
  fingerprint: {
    algorithm: "sha256";
    hash: string;
    structure: {
      readyState: string;
      landmarkCount: number;
      buttonCount: number;
      inputCount: number;
      linkCount: number;
      dialogCount: number;
      menuCount: number;
    };
  };
  failure?: {
    code: ChatgptCapabilityFailureCode;
  };
}

export interface ChatgptTurnResult {
  status: "completed" | "submitted" | "failed";
  submitted?: boolean;
  conversationUrl?: string;
  submittedAt?: string;
  earliestRecoveryAt?: string;
  recommendedRecoveryDelayMs?: number;
  monitoringGuidance?: string;
  answerText: string;
  answerMarkdown: string;
  answerHtml?: string;
  citations?: BrowserResponseCitation[];
  codeBlocks?: BrowserResponseCodeBlock[];
  tables?: BrowserResponseTable[];
  fileRefs?: BrowserResponseFileRef[];
  imageRefs?: BrowserResponseImageRef[];
  provenance?: BrowserResponseProvenance[];
  tookMs: number;
  answerChars: number;
  answerTokens: number;
  chromeHost?: string;
  chromePort?: number;
  chromeTargetId?: string;
  snapshot?: ChatgptConversationSnapshot;
  generatedImages?: ChatgptGeneratedImage[];
  newGeneratedImages?: ChatgptGeneratedImage[];
  sandboxArtifacts?: ChatgptSandboxArtifactRef[];
  newSandboxArtifacts?: ChatgptSandboxArtifactRef[];
  downloadedSandboxArtifacts?: ChatgptDownloadedSandboxArtifact[];
  thinkingTimeSelection?: ThinkingTimeSelectionResult;
  warnings: string[];
}

export interface ChatgptProjectRef {
  name: string;
  url?: string;
  projectId?: string;
  documentIndex: number;
}

export interface ChatgptProjectListResult {
  page: ChatgptPageSnapshot;
  projects: ChatgptProjectRef[];
  warnings: string[];
}

export interface ChatgptProjectConversationRef {
  title: string;
  url: string;
  conversationId?: string;
  projectId?: string;
  documentIndex: number;
}

export interface ChatgptProjectSnapshotResult {
  page: ChatgptPageSnapshot;
  project: ChatgptProjectRef;
  conversations: ChatgptProjectConversationRef[];
  warnings: string[];
}

export interface ChatgptProjectCreateResult {
  pageBefore: ChatgptPageSnapshot;
  pageAfter: ChatgptPageSnapshot;
  project: ChatgptProjectRef;
  created: boolean;
  verification: "project_page_opened" | "response_project_id" | "not_verified";
  warnings: string[];
}

export interface ChatgptConversationDeletePlanResult {
  page: ChatgptPageSnapshot;
  conversationUrl: string;
  conversationId?: string;
  matchedConversation?: ChatgptProjectConversationRef;
  canAttemptDelete: boolean;
  warnings: string[];
}

export interface ChatgptConversationDeleteResult {
  pageBefore: ChatgptPageSnapshot;
  pageAfter: ChatgptPageSnapshot;
  conversationUrl: string;
  conversationId: string;
  matchedConversation?: ChatgptProjectConversationRef;
  deleted: boolean;
  verification: "url_changed" | "conversation_unavailable" | "not_verified";
  warnings: string[];
}

export interface ChatgptConversationMoveResult {
  pageBefore: ChatgptPageSnapshot;
  pageAfter: ChatgptPageSnapshot;
  conversationUrl: string;
  conversationId: string;
  targetProject: ChatgptProjectRef;
  movedConversation?: ChatgptProjectConversationRef;
  moved: boolean;
  verification:
    | "project_link_found"
    | "page_title_project"
    | "url_changed_to_project"
    | "not_verified";
  warnings: string[];
}

export interface ChatgptProjectRenameResult {
  pageBefore: ChatgptPageSnapshot;
  pageAfter: ChatgptPageSnapshot;
  projectBefore: ChatgptProjectRef;
  projectAfter: ChatgptProjectRef;
  oldName: string;
  newName: string;
  renamed: boolean;
  verification: "name_updated" | "unchanged_same_name" | "not_verified";
  warnings: string[];
}

export type ChatgptFilePreflightStatus =
  | "accepted"
  | "unsupported"
  | "too_large"
  | "quota_exhausted"
  | "rate_limited"
  | "requires_action";

export type ChatgptFileUploadState =
  | "staged"
  | "streaming"
  | "ready"
  | "submitted"
  | "associated"
  | "failed";

/**
 * Quota lanes are intentionally open-ended: ChatGPT can expose different
 * counters for files, images, and message sends, and the browser must not
 * silently map one lane to another.
 */
export type ChatgptFileQuotaLane = string;

export interface ChatgptFileFingerprint {
  readonly absolutePath: string;
  readonly displayName: string;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
  readonly device?: number;
  readonly inode?: number;
  readonly sha256: string;
}

export interface ChatgptFileQuotaObservation {
  readonly lane: ChatgptFileQuotaLane;
  readonly observedAt: string;
  readonly source: "browser" | "response" | "header" | "caller";
  readonly used?: number;
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetAt?: string;
}

export interface ChatgptFileRateLimitObservation {
  readonly lane: ChatgptFileQuotaLane;
  readonly observedAt: string;
  readonly source: "browser" | "response" | "header" | "caller";
  readonly retryAfterMs?: number;
}

export interface ChatgptFileEvidence {
  readonly observedAt: string;
  readonly lane: ChatgptFileQuotaLane;
  readonly sizeBytes: number;
  readonly mimeType?: string;
  readonly extension?: string;
  readonly maxBytes?: number;
  readonly quota?: ChatgptFileQuotaObservation;
  readonly rateLimit?: ChatgptFileRateLimitObservation;
  readonly reason?: string;
  readonly action?: string;
}

export interface ChatgptFilePreflightResult {
  readonly operation: "file.preflight";
  readonly status: ChatgptFilePreflightStatus;
  readonly fingerprint: ChatgptFileFingerprint;
  readonly evidence: ChatgptFileEvidence;
  readonly retryAfterMs?: number;
}

export interface ChatgptFileProgress {
  readonly state: ChatgptFileUploadState;
  readonly loadedBytes: number;
  readonly totalBytes: number;
  readonly percent: number | null;
  readonly updatedAt: string;
}

export interface ChatgptFileAssociation {
  readonly conversationId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly fileId?: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ChatgptFileUploadResult {
  readonly operation: "file.upload";
  readonly state: ChatgptFileUploadState;
  readonly fingerprint: ChatgptFileFingerprint;
  readonly progress: readonly ChatgptFileProgress[];
  readonly fileId?: string;
  readonly association?: ChatgptFileAssociation;
  readonly associations?: readonly ChatgptFileAssociation[];
  readonly error?: ChatgptFileError;
}

export interface ChatgptFileRecord {
  readonly fileId: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly sha256?: string;
  readonly mimeType?: string;
  readonly conversationId?: string;
  readonly turnId?: string;
  readonly messageId?: string;
}

export interface ChatgptFileDownloadPolicy {
  /**
   * Maximum bytes accepted from a ChatGPT download. This is supplied by the
   * trusted integration boundary and is never taken from a tool request.
   */
  readonly maxDownloadBytes: number;
  /**
   * Operator-approved directory under which downloads may be written.
   */
  readonly approvedOutputRoot: string;
}

export interface ChatgptFileDownloadProvenance {
  readonly source: "chatgpt-file";
  readonly fileId: string;
  readonly name: string;
  readonly conversationId?: string;
  readonly turnId?: string;
  readonly messageId?: string;
}

export interface ChatgptFileDownload {
  readonly operation: "file.download";
  readonly fileId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly downloadedPath: string;
  readonly provenance: ChatgptFileDownloadProvenance;
}

export interface ChatgptFileError {
  readonly code:
    | "unsupported"
    | "too_large"
    | "quota_exhausted"
    | "rate_limited"
    | "requires_action"
    | "disconnected"
    | "association_mismatch"
    | "transport"
    | "unknown";
  readonly message: string;
  readonly retryAfterMs?: number;
  readonly lane?: ChatgptFileQuotaLane;
  readonly quota?: ChatgptFileQuotaObservation;
}

export interface ChatgptFileErrorClassification {
  readonly code: ChatgptFileError["code"];
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly lane?: ChatgptFileQuotaLane;
  readonly quota?: ChatgptFileQuotaObservation;
  readonly message: string;
}
