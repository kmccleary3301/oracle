import type { ThinkingTimeSelectionResult } from "../actions/thinkingTime.js";

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
}

export interface ChatgptDownloadedSandboxArtifact {
  label: string;
  turnIndex: number;
  turnId?: string | null;
  messageId?: string | null;
  documentIndex: number;
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

export interface ChatgptTurnResult {
  status: "completed";
  conversationUrl?: string;
  answerText: string;
  answerMarkdown: string;
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
