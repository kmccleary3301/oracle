import type {
  AdvancedPolicyCategory,
  AdvancedPolicyCapabilityEvidenceInput,
  AdvancedPolicyDecision,
  AdvancedPolicyEvidence,
  AdvancedPolicyReasonCode,
  AdvancedPolicyRequest,
} from "./advancedPolicyTypes.js";

export type * from "./advancedPolicyTypes.js";

/** Features intentionally outside the supported ChatGPT DOM boundary. */
export const ADVANCED_POLICY_NON_GOALS = Object.freeze([
  "account",
  "security",
  "payment",
  "subscription",
  "admin",
  "workspace_membership",
  "public_sharing",
  "javascript",
  "selector",
  "private_api",
  "oauth",
  "external_write",
] as const satisfies readonly AdvancedPolicyCategory[]);

export const ADVANCED_POLICY_UNSUPPORTED_REASON_CODES = Object.freeze({
  account: "account_control_outside_observed_ui",
  security: "security_control_outside_observed_ui",
  payment: "payment_control_outside_observed_ui",
  subscription: "subscription_control_outside_observed_ui",
  admin: "admin_control_outside_observed_ui",
  workspace_membership: "workspace_membership_outside_observed_ui",
  public_sharing: "public_sharing_outside_observed_ui",
  javascript: "arbitrary_javascript_unsupported",
  selector: "arbitrary_selector_unsupported",
  private_api: "private_api_token_unsupported",
  oauth: "autonomous_oauth_unsupported",
  external_write: "unknown_external_write_unsupported",
  unknown: "unknown_operation",
} as const satisfies Readonly<Record<AdvancedPolicyCategory, AdvancedPolicyReasonCode>>);

const REASON_TEXT: Readonly<Record<AdvancedPolicyReasonCode, string>> = {
  account_control_outside_observed_ui: "Account controls outside the observed UI are unsupported.",
  security_control_outside_observed_ui:
    "Security controls outside the observed UI are unsupported.",
  payment_control_outside_observed_ui: "Payment controls outside the observed UI are unsupported.",
  subscription_control_outside_observed_ui:
    "Subscription controls outside the observed UI are unsupported.",
  admin_control_outside_observed_ui:
    "Administration controls outside the observed UI are unsupported.",
  workspace_membership_outside_observed_ui:
    "Workspace membership controls outside the observed UI are unsupported.",
  public_sharing_outside_observed_ui: "Public sharing outside the observed UI is unsupported.",
  arbitrary_javascript_unsupported: "Arbitrary JavaScript execution is unsupported.",
  arbitrary_selector_unsupported: "Arbitrary selectors are unsupported.",
  private_api_token_unsupported: "Private API tokens are unsupported.",
  autonomous_oauth_unsupported: "Autonomous OAuth authorization is unsupported.",
  unknown_external_write_unsupported: "Unknown external writes are unsupported.",
  capability_not_observed: "The requested capability was not observed in the current UI.",
  approval_required: "An explicitly observed consequential operation requires user approval.",
  unknown_operation: "The requested operation could not be classified safely.",
};

const CATEGORY_ALIASES: Readonly<Record<string, AdvancedPolicyCategory>> = {
  account: "account",
  accounts: "account",
  profile: "account",
  security: "security",
  auth: "security",
  authentication: "security",
  payment: "payment",
  payments: "payment",
  billing: "payment",
  subscription: "subscription",
  subscriptions: "subscription",
  plan: "subscription",
  admin: "admin",
  administration: "admin",
  workspace: "workspace_membership",
  membership: "workspace_membership",
  "workspace-membership": "workspace_membership",
  workspace_membership: "workspace_membership",
  sharing: "public_sharing",
  share: "public_sharing",
  "public-sharing": "public_sharing",
  public_sharing: "public_sharing",
  javascript: "javascript",
  js: "javascript",
  selector: "selector",
  selectors: "selector",
  "private-api": "private_api",
  private_api: "private_api",
  token: "private_api",
  oauth: "oauth",
  "external-write": "external_write",
  external_write: "external_write",
};

const CONTROL_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
const SECRET_KEY = /(?:token|secret|password|cookie|authorization|credential|api[-_ ]?key)/i;
const CODE_KEY = /^(?:javascript|script|code|expression|eval)$/i;
const SELECTOR_KEY = /selector|queryselector/i;
const OAUTH_KEY = /oauth|authorize|authorization/i;
const WRITE_KEY =
  /^(?:write|mutat|delete|remove|create|update|pause|resume|share|send|invite|payment|billing|subscribe)/i;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function bool(value: unknown): boolean {
  return value === true;
}

function classifyCategory(input: AdvancedPolicyRequest): AdvancedPolicyCategory {
  const values = [input.category, input.capability, input.operation]
    .filter((value): value is string => typeof value === "string")
    .map((value) => text(value));
  for (const value of values) {
    const aliases = Object.entries(CATEGORY_ALIASES).sort((a, b) => b[0].length - a[0].length);
    for (const [alias, category] of aliases) {
      if (value === alias || value.includes(alias)) return category;
    }
  }
  return "unknown";
}

function classifyOperation(input: AdvancedPolicyRequest): "read" | "write" | "unknown" {
  if (bool(input.write)) return "write";
  if (typeof input.operation === "string") {
    if (WRITE_KEY.test(input.operation.trim())) return "write";
    if (/^(?:read|get|list|inspect|probe|status|preview|view)/i.test(input.operation.trim()))
      return "read";
  }
  return "unknown";
}

function safeCapabilityEvidence(value: unknown): AdvancedPolicyEvidence["capabilityEvidence"] {
  if (!value || typeof value !== "object") return undefined;
  const input = value as AdvancedPolicyCapabilityEvidenceInput;
  const source = input.source === "chatgpt-dom" ? "chatgpt-dom" : "unknown";
  const pageIdentity = ["chatgpt_app", "auth", "challenge", "other", "unknown"].includes(
    String(input.pageIdentity),
  )
    ? (String(input.pageIdentity) as "chatgpt_app" | "auth" | "challenge" | "other" | "unknown")
    : "unknown";
  const loginState = ["logged_in", "login_required", "challenge_required", "unknown"].includes(
    String(input.loginState),
  )
    ? (String(input.loginState) as
        | "logged_in"
        | "login_required"
        | "challenge_required"
        | "unknown")
    : "unknown";
  const controls: Record<string, "available" | "unavailable" | "unknown"> = {};
  if (input.controls && typeof input.controls === "object" && !Array.isArray(input.controls)) {
    for (const [key, raw] of Object.entries(input.controls)) {
      if (!CONTROL_KEY.test(key) || SECRET_KEY.test(key)) continue;
      if (raw === "available" || raw === "unavailable") controls[key] = raw;
    }
  }
  return { source, pageIdentity, loginState, controls };
}

export function sanitizeAdvancedPolicyEvidence(
  input: AdvancedPolicyRequest = {},
): AdvancedPolicyEvidence {
  const category = classifyCategory(input);
  const operation = classifyOperation(input);
  const containsCode = Object.entries(input).some(
    ([key, value]) =>
      CODE_KEY.test(key) &&
      value !== undefined &&
      value !== null &&
      String(value).trim().length > 0,
  );
  const containsSelector = Object.entries(input).some(
    ([key, value]) =>
      SELECTOR_KEY.test(key) &&
      value !== undefined &&
      value !== null &&
      String(value).trim().length > 0,
  );
  const containsCredential = Object.entries(input).some(
    ([key, value]) =>
      SECRET_KEY.test(key) &&
      value !== undefined &&
      value !== null &&
      String(value).trim().length > 0,
  );
  const containsOauth = Object.entries(input).some(
    ([key, value]) =>
      OAUTH_KEY.test(key) &&
      value !== undefined &&
      value !== null &&
      String(value).trim().length > 0,
  );
  const external = bool(input.external) || category === "external_write";
  const observedUi =
    bool(input.observedUi) ||
    bool(input.capabilityObserved) ||
    bool(input.capabilityEvidence?.observed) ||
    input.capabilityEvidence?.source === "chatgpt-dom";
  const redactions = ["target", "pageText", "selector", "script", "credential", "token"].filter(
    (field) => {
      if (field === "target") return input.targetId !== undefined;
      if (field === "selector") return containsSelector;
      if (field === "script") return containsCode;
      if (field === "credential" || field === "token") return containsCredential;
      return Object.prototype.hasOwnProperty.call(input, field);
    },
  );
  return {
    sanitized: true,
    category,
    operation,
    external,
    observedUi,
    capability: observedUi ? "observed" : "unobserved",
    target:
      input.targetId === undefined || input.targetId === null || text(input.targetId) === ""
        ? "absent"
        : "present",
    containsCode,
    containsSelector,
    containsCredential,
    containsOauth,
    redactions,
    ...(safeCapabilityEvidence(input.capabilityEvidence)
      ? { capabilityEvidence: safeCapabilityEvidence(input.capabilityEvidence) }
      : {}),
  };
}

function decision(
  input: AdvancedPolicyRequest,
  classification: AdvancedPolicyDecision["classification"],
  reasonCode: AdvancedPolicyReasonCode,
): AdvancedPolicyDecision {
  return {
    classification,
    reasonCode,
    reason: REASON_TEXT[reasonCode],
    evidence: sanitizeAdvancedPolicyEvidence(input),
  };
}

/** Classifies before any advanced operation is dispatched to a browser or network boundary. */
export function classifyAdvancedPolicy(input: AdvancedPolicyRequest = {}): AdvancedPolicyDecision {
  const category = classifyCategory(input);
  const evidence = sanitizeAdvancedPolicyEvidence(input);
  if (evidence.containsCode || category === "javascript")
    return decision(input, "unsupported", "arbitrary_javascript_unsupported");
  if (evidence.containsSelector || category === "selector")
    return decision(input, "unsupported", "arbitrary_selector_unsupported");
  if (
    evidence.containsCredential ||
    category === "private_api" ||
    input.privateApiToken !== undefined ||
    input.apiToken !== undefined
  )
    return decision(input, "unsupported", "private_api_token_unsupported");
  const oauthAutonomous =
    category === "oauth" &&
    (bool(input.autonomous) ||
      bool(input.oauth) ||
      /auto|silent|background/i.test(String(input.operation ?? "")));
  if (oauthAutonomous) return decision(input, "unsupported", "autonomous_oauth_unsupported");
  if (category !== "unknown" && category !== "external_write") {
    return decision(input, "unsupported", ADVANCED_POLICY_UNSUPPORTED_REASON_CODES[category]);
  }
  const unknownExternalWrite =
    bool(input.unknownExternalWrite) ||
    (evidence.external && evidence.operation === "write" && !evidence.observedUi);
  if (unknownExternalWrite)
    return decision(input, "unsupported", "unknown_external_write_unsupported");
  if (evidence.operation === "write" && evidence.observedUi)
    return decision(input, "requires_action", "approval_required");
  if (!evidence.observedUi) return decision(input, "requires_action", "capability_not_observed");
  return decision(input, "requires_action", "unknown_operation");
}

export const classifyAdvancedCapability = classifyAdvancedPolicy;
export const classifyAdvancedOperation = classifyAdvancedPolicy;
export const sanitizeAdvancedEvidence = sanitizeAdvancedPolicyEvidence;
