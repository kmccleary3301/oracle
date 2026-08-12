import type CDP from "chrome-remote-interface";
import type Protocol from "devtools-protocol";
import type {
  BrowserModelSelectionEvidence,
  BrowserRunWarning,
  BrowserRuntimeMetadata,
} from "../sessionStore.js";
import type { SessionArtifact } from "../sessionStore.js";
import type { ThinkingTimeLevel } from "../oracle/types.js";
import type {
  ChatgptDownloadedSandboxArtifact,
  ChatgptSandboxArtifactRef,
} from "./chatgpt/types.js";
import type {
  ChatgptConversationDivergencePolicy,
  ChatgptConversationRevision,
} from "./chatgpt/revision.js";

import type { ThinkingTimeSelectionResult } from "./actions/thinkingTime.js";

export type ChromeClient = Awaited<ReturnType<typeof CDP>>;
export type CookieParam = Protocol.Network.CookieParam;
export type BrowserModelStrategy = "select" | "current" | "ignore";
export type BrowserResearchMode = "off" | "deep";
export type BrowserArchiveMode = "auto" | "always" | "never";

export type BrowserLogger = ((message: string) => void) & {
  verbose?: boolean;
  sessionLog?: (message: string) => void;
};

export interface BrowserAttachment {
  path: string;
  hostPaths?: string[];
  displayPath: string;
  sizeBytes?: number;
  generatedBundle?: boolean;
}

export interface BrowserGeneratedImage {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
  fileId?: string;
}

export interface BrowserDownloadableFile {
  url: string;
  downloadUrl?: string;
  sandboxUrl?: string;
  filename?: string;
  label?: string;
  mimeType?: string;
}

export interface SavedBrowserImage extends SessionArtifact {
  kind: "image";
  url: string;
  finalUrl?: string;
  alt?: string;
  width?: number;
  height?: number;
  fileId?: string;
}

export interface SavedBrowserFile extends SessionArtifact {
  kind: "file";
  url: string;
  finalUrl?: string;
  sandboxUrl?: string;
  filename?: string;
}
export interface BrowserResponseCitation {
  href: string;
  text: string;
  title?: string;
  turnId?: string | null;
  messageId?: string | null;
  turnIndex?: number;
}

export interface BrowserResponseCodeBlock {
  language?: string;
  code: string;
  turnId?: string | null;
  messageId?: string | null;
  turnIndex?: number;
}

export interface BrowserResponseTable {
  headers: string[];
  rows: string[][];
  turnId?: string | null;
  messageId?: string | null;
  turnIndex?: number;
}

export interface BrowserResponseFileRef {
  href?: string;
  name?: string;
  mimeType?: string;
  turnId?: string | null;
  messageId?: string | null;
  turnIndex?: number;
}

export interface BrowserResponseImageRef {
  src: string;
  alt?: string;
  title?: string;
  turnId?: string | null;
  messageId?: string | null;
  turnIndex?: number;
}

export interface BrowserResponseProvenance {
  source: "chatgpt-dom";
  capturedAt: string;
  conversationUrl?: string;
  conversationId?: string;
  turnId?: string | null;
  messageId?: string | null;
  turnIndex?: number;
  modelSelection?: BrowserModelSelectionEvidence;
}

export interface BrowserAutomationConfig {
  chromeProfile?: string | null;
  chromePath?: string | null;
  chromeCookiePath?: string | null;
  attachRunning?: boolean;
  browserTabRef?: string | null;
  url?: string;
  chatgptUrl?: string | null;
  timeoutMs?: number;
  debugPort?: number | null;
  inputTimeoutMs?: number;
  /** Time budget for attachment upload/readiness before clicking send. */
  attachmentTimeoutMs?: number;
  /** Delay before rechecking the conversation after an assistant timeout. */
  assistantRecheckDelayMs?: number;
  /** Time budget for the delayed recheck attempt. */
  assistantRecheckTimeoutMs?: number;
  /** Wait for an existing shared Chrome to appear before launching a new one. */
  reuseChromeWaitMs?: number;
  /** Max time to wait for a shared manual-login profile lock (serializes parallel runs). */
  profileLockTimeoutMs?: number;
  /** Soft limit for concurrent ChatGPT tabs sharing one manual-login profile. */
  maxConcurrentTabs?: number;
  /** Delay before starting periodic auto-reattach attempts after a timeout. */
  autoReattachDelayMs?: number;
  /** Interval between auto-reattach attempts (0 disables). */
  autoReattachIntervalMs?: number;
  /** Time budget for each auto-reattach attempt. */
  autoReattachTimeoutMs?: number;
  /** Interval between OS process-tree memory samples for locally owned Chrome. */
  resourceMonitorIntervalMs?: number;
  /** Pause threshold for locally owned Chrome process-tree RSS. */
  resourceRssSoftLimitBytes?: number;
  /** Mandatory shutdown threshold for locally owned Chrome process-tree RSS. */
  resourceRssHardLimitBytes?: number;
  /** Hysteresis threshold below which memory admission resumes. */
  resourceRssResumeLimitBytes?: number;
  cookieSync?: boolean;
  cookieNames?: string[] | null;
  cookieSyncWaitMs?: number;
  inlineCookies?: CookieParam[] | null;
  inlineCookiesSource?: string | null;
  headless?: boolean;
  keepBrowser?: boolean;
  hideWindow?: boolean;
  desiredModel?: string | null;
  modelStrategy?: BrowserModelStrategy;
  debug?: boolean;
  allowCookieErrors?: boolean;
  remoteChrome?: { host: string; port: number } | null;
  remoteChromeBrowserWSEndpoint?: string | null;
  remoteChromeProfileRoot?: string | null;
  /** Max number of Oracle-managed remote Chrome tabs to keep open concurrently. */
  remoteChromeMaxTabs?: number;
  manualLogin?: boolean;
  manualLoginProfileDir?: string | null;
  manualLoginCookieSync?: boolean;
  /** Copy this signed-in Chrome user-data dir to a throwaway profile and run against it (login-free). */
  copyProfileSource?: string | null;
  sandboxArtifactsOutputDir?: string | null;
  /** Thinking time intensity level for Thinking/Pro models: light, standard, extended, heavy */
  thinkingTime?: ThinkingTimeLevel;
  /** Browser-only research mode. "deep" activates ChatGPT Deep Research. */
  researchMode?: BrowserResearchMode;
  /** Archive completed ChatGPT conversations after local artifacts are saved. */
  archiveConversations?: BrowserArchiveMode;
  /** Existing ChatGPT conversation URL to open before submitting the prompt. */
  resumeConversationUrl?: string | null;
  /** Whether missing Thinking controls should fail the run or continue with current/default mode. */
  thinkingFallback?: "allow" | "fail";
}

export interface BrowserRunOptions {
  prompt: string;
  attachments?: BrowserAttachment[];
  /**
   * Optional secondary submission to try if the initial prompt is rejected by ChatGPT
   * (e.g. inline file paste exceeds composer limits). Intended for auto inline->upload fallback.
   */
  fallbackSubmission?: { prompt: string; attachments: BrowserAttachment[] };
  /** Expected conversation head captured before submitting a resumed turn. */
  expectedRevision?: ChatgptConversationRevision;
  /** Policy for handling external changes to the expected conversation head. */
  divergencePolicy?: ChatgptConversationDivergencePolicy;
  config?: BrowserAutomationConfig;
  /** Requested ChatGPT mode. Chat remains the default; Work never silently falls back to Chat. */
  requestedMode?: "chat" | "work";
  log?: BrowserLogger;
  heartbeatIntervalMs?: number;
  verbose?: boolean;
  /** Session id used for cross-process browser slot diagnostics. */
  sessionId?: string;
  /** Browser-only image generation output path. */
  generateImagePath?: string;
  /** Optional output path for image operations. */
  outputPath?: string;
  /** Additional prompts to submit in the same browser conversation after the initial answer. */
  followUpPrompts?: string[];
  /**
   * Close a newly-created completed run tab even when the owning Chrome process
   * must remain alive. Used by long-lived shared browser services; incomplete
   * and attached-existing tabs are still preserved for recovery/user ownership.
   */
  closeOwnedTabOnComplete?: boolean;
  /** Optional hook to persist runtime info and current model evidence as soon as Chrome is ready. */
  runtimeHintCb?: (
    hint: BrowserRuntimeMetadata,
    modelSelection?: BrowserModelSelectionEvidence,
  ) => void | Promise<void>;
  /**
   * Submit the turn, persist the conversation URL/runtime, and return without waiting for
   * the assistant response. Useful when ChatGPT will keep long Pro work running server-side.
   */
  returnAfterSubmit?: boolean;
  /** Persist submission intent immediately before the send interaction. */
  beforeSend?: () => void | Promise<void>;
  /** Persist dispatch acknowledgement immediately after Send/Enter dispatch. */
  onPromptSubmitted?: () => void | Promise<void>;
}

export interface BrowserArchiveResult {
  mode: BrowserArchiveMode;
  attempted: boolean;
  archived: boolean;
  reason?: string;
  conversationUrl?: string;
  error?: string;
}

export interface BrowserRunResult {
  answerText: string;
  answerMarkdown: string;
  answerHtml?: string;
  citations?: BrowserResponseCitation[];
  codeBlocks?: BrowserResponseCodeBlock[];
  tables?: BrowserResponseTable[];
  fileRefs?: BrowserResponseFileRef[];
  imageRefs?: BrowserResponseImageRef[];
  provenance?: BrowserResponseProvenance[];
  artifacts?: SessionArtifact[];
  generatedImages?: BrowserGeneratedImage[];
  savedImages?: SavedBrowserImage[];
  downloadableFiles?: BrowserDownloadableFile[];
  savedFiles?: SavedBrowserFile[];
  archive?: BrowserArchiveResult;
  modelSelection?: BrowserModelSelectionEvidence;
  warnings?: BrowserRunWarning[];
  tookMs: number;
  answerTokens: number;
  answerChars: number;
  browserTransport?: "cdp";
  submitted?: boolean;
  chromePid?: number;
  chromePort?: number;
  chromeHost?: string;
  chromeBrowserWSEndpoint?: string;
  chromeProfileRoot?: string;
  userDataDir?: string;
  chromeTargetId?: string;
  tabUrl?: string;
  conversationId?: string;
  promptSubmitted?: boolean;
  controllerPid?: number;
  sandboxArtifacts?: ChatgptSandboxArtifactRef[];
  newSandboxArtifacts?: ChatgptSandboxArtifactRef[];
  downloadedSandboxArtifacts?: ChatgptDownloadedSandboxArtifact[];
  thinkingTimeSelection?: ThinkingTimeSelectionResult;
}

export type ResolvedBrowserConfig = Required<
  Omit<
    BrowserAutomationConfig,
    | "chromeProfile"
    | "chromePath"
    | "chromeCookiePath"
    | "desiredModel"
    | "remoteChrome"
    | "remoteChromeBrowserWSEndpoint"
    | "remoteChromeProfileRoot"
    | "thinkingTime"
    | "thinkingFallback"
    | "modelStrategy"
    | "maxConcurrentTabs"
    | "researchMode"
    | "copyProfileSource"
  >
> & {
  chromeProfile?: string | null;
  chromePath?: string | null;
  chromeCookiePath?: string | null;
  attachRunning?: boolean;
  browserTabRef?: string | null;
  desiredModel?: string | null;
  modelStrategy?: BrowserModelStrategy;
  thinkingTime?: ThinkingTimeLevel;
  thinkingFallback?: "allow" | "fail";
  debugPort?: number | null;
  inlineCookiesSource?: string | null;
  remoteChrome?: { host: string; port: number } | null;
  remoteChromeBrowserWSEndpoint?: string | null;
  remoteChromeProfileRoot?: string | null;
  remoteChromeMaxTabs?: number;
  manualLogin?: boolean;
  manualLoginProfileDir?: string | null;
  manualLoginCookieSync?: boolean;
  copyProfileSource?: string | null;
  maxConcurrentTabs: number;
  researchMode: BrowserResearchMode;
  archiveConversations: BrowserArchiveMode;
  sandboxArtifactsOutputDir?: string | null;
};
