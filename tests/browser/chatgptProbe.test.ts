import { describe, expect, it } from "vitest";
import {
  buildCapabilityProbeExpressionForTest,
  normalizeCapabilityProbeObservationForTest,
  settleCapabilityProbeObservationsForTest,
} from "../../src/browser/chatgpt/probe.js";

describe("ChatGPT capability probe", () => {
  it("returns a typed inventory and drops private labels", () => {
    const result = normalizeCapabilityProbeObservationForTest(
      {
        page: { identityClass: "chatgpt_app", readyState: "complete", locale: "en-US" },
        auth: { state: "logged_in", challenge: "none" },
        controls: {
          modes: ["chat", "work", "private workspace title"],
          models: ["gpt-5.6", "private model label"],
          effort: ["extended", "private effort description"],
          uploads: { file: true, image: true, multiple: true },
        },
        indicators: {
          project: true,
          projectSources: true,
          work: true,
          research: false,
          tools: ["browser", "private connector name"],
        },
        structure: {
          readyState: "complete",
          landmarkCount: 4,
          buttonCount: 12,
          inputCount: 2,
          linkCount: 8,
          dialogCount: 0,
          menuCount: 1,
        },
      },
      "2026-08-10T12:00:00.000Z",
      { host: "127.0.0.1", port: 9222 },
    );

    expect(result).toMatchObject({
      schemaVersion: 1,
      status: "ok",
      capturedAt: "2026-08-10T12:00:00.000Z",
      adapterVersion: expect.any(String),
      page: { identityClass: "chatgpt_app", readyState: "complete", locale: "en-US" },
      auth: { state: "logged_in", challenge: "none" },
      controls: {
        modes: ["chat", "work"],
        models: ["gpt-5.6"],
        effort: ["extended"],
        uploads: { file: true, image: true, multiple: true },
      },
      indicators: {
        project: true,
        projectSources: true,
        work: true,
        research: false,
        tools: ["browser"],
      },
      fingerprint: {
        algorithm: "sha256",
        hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private workspace title");
    expect(serialized).not.toContain("private model label");
    expect(serialized).not.toContain("private effort description");
    expect(serialized).not.toContain("private connector name");
  });

  it("waits for the authenticated composer to hydrate", async () => {
    const result = await settleCapabilityProbeObservationsForTest([
      {
        page: { identityClass: "chatgpt_app", readyState: "complete", locale: "en-US" },
        auth: { state: "unknown", challenge: "none" },
        controls: { modes: [], models: [], effort: [], uploads: {} },
        indicators: {},
        structure: { readyState: "complete" },
      },
      {
        page: { identityClass: "chatgpt_app", readyState: "complete", locale: "en-US" },
        auth: { state: "logged_in", challenge: "none" },
        controls: {
          modes: ["chat"],
          models: ["gpt-5.6"],
          effort: ["extended"],
          uploads: { file: true, image: true, multiple: true },
        },
        indicators: { project: true },
        structure: { readyState: "complete", landmarkCount: 3 },
      },
    ]);

    expect(result).toMatchObject({
      status: "ok",
      auth: { state: "logged_in" },
      controls: { modes: ["chat"], models: ["gpt-5.6"] },
      indicators: { project: true },
    });
  });

  it("expression only returns redacted capability fields", () => {
    const expression = buildCapabilityProbeExpressionForTest();
    expect(expression).toContain("identityClass");
    expect(expression).toContain("readyState");
    expect(expression).toContain("navigator.language");
    expect(expression).not.toContain("conversationId");
    expect(expression).not.toContain("prompt-textarea.value");
  });
});
