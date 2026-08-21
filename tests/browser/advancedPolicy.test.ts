import { describe, expect, it } from "vitest";
import {
  ADVANCED_POLICY_NON_GOALS,
  ADVANCED_POLICY_UNSUPPORTED_REASON_CODES,
  classifyAdvancedPolicy,
  sanitizeAdvancedPolicyEvidence,
} from "../../src/browser/advancedPolicy.js";

const unsupportedCategories = [
  "account",
  "security",
  "payment",
  "subscription",
  "admin",
  "workspace_membership",
  "public_sharing",
] as const;

describe("advanced policy boundary", () => {
  it("declares every advanced non-goal explicitly", () => {
    expect(ADVANCED_POLICY_NON_GOALS).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(Object.keys(ADVANCED_POLICY_UNSUPPORTED_REASON_CODES)).toEqual(
      expect.arrayContaining([...ADVANCED_POLICY_NON_GOALS]),
    );
  });

  it.each(unsupportedCategories)("rejects %s controls outside observed UI", (category) => {
    const result = classifyAdvancedPolicy({
      category,
      operation: "update",
      observedUi: false,
      targetId: "secret-target",
    });
    expect(result.classification).toBe("unsupported");
    const reasonCodes: Record<string, string> = {
      account: "account_control_outside_observed_ui",
      security: "security_control_outside_observed_ui",
      payment: "payment_control_outside_observed_ui",
      subscription: "subscription_control_outside_observed_ui",
      admin: "admin_control_outside_observed_ui",
      workspace_membership: "workspace_membership_outside_observed_ui",
      public_sharing: "public_sharing_outside_observed_ui",
    };
    expect(result.reasonCode).toBe(reasonCodes[category]);
    expect(JSON.stringify(result.evidence)).not.toContain("secret-target");
  });

  it("rejects arbitrary JavaScript, selectors, private tokens, and autonomous OAuth", () => {
    expect(classifyAdvancedPolicy({ script: "fetch('https://evil.test')" }).reasonCode).toBe(
      "arbitrary_javascript_unsupported",
    );
    expect(classifyAdvancedPolicy({ selector: "[data-secret='x']" }).reasonCode).toBe(
      "arbitrary_selector_unsupported",
    );
    expect(classifyAdvancedPolicy({ privateApiToken: "sk-secret-token" }).reasonCode).toBe(
      "private_api_token_unsupported",
    );
    expect(
      classifyAdvancedPolicy({ category: "oauth", oauth: true, autonomous: true }).reasonCode,
    ).toBe("autonomous_oauth_unsupported");
  });

  it("does not claim unknown external writes succeeded", () => {
    const result = classifyAdvancedPolicy({
      operation: "write",
      external: true,
      targetId: "customer-123",
      observedUi: false,
    });
    expect(result).toMatchObject({
      classification: "unsupported",
      reasonCode: "unknown_external_write_unsupported",
    });
  });

  it("requires explicit approval only for an observed consequential control", () => {
    const result = classifyAdvancedPolicy({
      operation: "update",
      write: true,
      observedUi: true,
      targetId: "target-1",
      capabilityEvidence: {
        source: "chatgpt-dom",
        pageIdentity: "chatgpt_app",
        loginState: "logged_in",
        controls: { rename: "available" },
      },
    });
    expect(result).toMatchObject({
      classification: "requires_action",
      reasonCode: "approval_required",
    });
    expect(result.evidence.capabilityEvidence).toEqual({
      source: "chatgpt-dom",
      pageIdentity: "chatgpt_app",
      loginState: "logged_in",
      controls: { rename: "available" },
    });
  });

  it("redacts untrusted values while retaining bounded capability facts", () => {
    const evidence = sanitizeAdvancedPolicyEvidence({
      category: "account",
      targetId: "alice@example.com",
      script: "document.cookie",
      selector: "input[name=password]",
      apiToken: "private-secret",
      capabilityEvidence: {
        source: "chatgpt-dom",
        pageIdentity: "chatgpt_app",
        loginState: "logged_in",
        controls: { rename: "available", "secret-token": "available", injected: "arbitrary" },
      },
    });
    expect(evidence.sanitized).toBe(true);
    expect(evidence.target).toBe("present");
    expect(evidence.containsCode).toBe(true);
    expect(evidence.containsSelector).toBe(true);
    expect(evidence.containsCredential).toBe(true);
    expect(evidence.capabilityEvidence?.controls).toEqual({ rename: "available" });
    expect(JSON.stringify(evidence)).not.toContain("alice@example.com");
    expect(JSON.stringify(evidence)).not.toContain("document.cookie");
    expect(JSON.stringify(evidence)).not.toContain("input[name=password]");
    expect(JSON.stringify(evidence)).not.toContain("private-secret");
  });
});
