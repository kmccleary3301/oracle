export type AdvancedPolicyClassification = "unsupported" | "requires_action";

export type AdvancedPolicyCategory =
  | "account"
  | "security"
  | "payment"
  | "subscription"
  | "admin"
  | "workspace_membership"
  | "public_sharing"
  | "javascript"
  | "selector"
  | "private_api"
  | "oauth"
  | "external_write"
  | "unknown";

export type AdvancedPolicyReasonCode =
  | "account_control_outside_observed_ui"
  | "security_control_outside_observed_ui"
  | "payment_control_outside_observed_ui"
  | "subscription_control_outside_observed_ui"
  | "admin_control_outside_observed_ui"
  | "workspace_membership_outside_observed_ui"
  | "public_sharing_outside_observed_ui"
  | "arbitrary_javascript_unsupported"
  | "arbitrary_selector_unsupported"
  | "private_api_token_unsupported"
  | "autonomous_oauth_unsupported"
  | "unknown_external_write_unsupported"
  | "capability_not_observed"
  | "approval_required"
  | "unknown_operation";

export interface AdvancedPolicyCapabilityEvidenceInput {
  source?: unknown;
  pageIdentity?: unknown;
  loginState?: unknown;
  controls?: unknown;
  observed?: unknown;
  uiControlObserved?: unknown;
}

/**
 * Evidence intentionally contains only bounded classifications and booleans.
 * It never echoes page text, selectors, credentials, target ids, or scripts.
 */
export interface AdvancedPolicyEvidence {
  sanitized: true;
  category: AdvancedPolicyCategory;
  operation: "read" | "write" | "unknown";
  external: boolean;
  observedUi: boolean;
  capability: "observed" | "unobserved";
  target: "present" | "absent";
  containsCode: boolean;
  containsSelector: boolean;
  containsCredential: boolean;
  containsOauth: boolean;
  redactions: readonly string[];
  capabilityEvidence?: {
    source: "chatgpt-dom" | "unknown";
    pageIdentity: "chatgpt_app" | "auth" | "challenge" | "other" | "unknown";
    loginState: "logged_in" | "login_required" | "challenge_required" | "unknown";
    controls: Readonly<Record<string, "available" | "unavailable" | "unknown">>;
  };
}

export interface AdvancedPolicyRequest {
  category?: unknown;
  operation?: unknown;
  capability?: unknown;
  targetId?: unknown;
  external?: unknown;
  write?: unknown;
  observedUi?: unknown;
  capabilityObserved?: unknown;
  selector?: unknown;
  cssSelector?: unknown;
  querySelector?: unknown;
  javascript?: unknown;
  script?: unknown;
  code?: unknown;
  apiToken?: unknown;
  privateApiToken?: unknown;
  authorization?: unknown;
  oauth?: unknown;
  autonomous?: unknown;
  unknownExternalWrite?: unknown;
  capabilityEvidence?: AdvancedPolicyCapabilityEvidenceInput;
  /** Additional provider fields are accepted and treated as untrusted input. */
  [key: string]: unknown;
}

export interface AdvancedPolicyDecision {
  classification: AdvancedPolicyClassification;
  reasonCode: AdvancedPolicyReasonCode;
  reason: string;
  evidence: AdvancedPolicyEvidence;
}
