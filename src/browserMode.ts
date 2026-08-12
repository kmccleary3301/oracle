export type {
  BrowserAutomationConfig,
  BrowserRunOptions,
  BrowserRunResult,
} from "./browser/index.js";

export {
  runBrowserMode,
  CHATGPT_URL,
  DEFAULT_MODEL_STRATEGY,
  DEFAULT_MODEL_TARGET,
  parseDuration,
  normalizeChatgptUrl,
  normalizeRemoteChatgptUrl,
  normalizeRemoteChatgptOrigins,
  DEFAULT_REMOTE_CHATGPT_ORIGINS,
  isTemporaryChatUrl,
} from "./browser/index.js";
