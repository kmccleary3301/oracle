import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadUserConfig: vi.fn(),
}));

vi.mock("../../src/config.js", () => ({
  loadUserConfig: mocks.loadUserConfig,
}));

import { resolveTrustedBrowserConfig } from "../../src/browser/trustedBrowserConfig.js";

describe("resolveTrustedBrowserConfig", () => {
  beforeEach(() => {
    mocks.loadUserConfig.mockResolvedValue({
      config: {
        browser: {
          remoteChrome: { host: "127.0.0.1", port: 9222 },
          remoteChromeMaxTabs: 4,
        },
      },
    });
  });

  test("uses the endpoint selected by trusted local configuration", async () => {
    await expect(resolveTrustedBrowserConfig()).resolves.toMatchObject({
      remoteChrome: { host: "127.0.0.1", port: 9222 },
      remoteChromeMaxTabs: 4,
    });
    await expect(resolveTrustedBrowserConfig("127.0.0.1:9222")).resolves.toMatchObject({
      remoteChrome: { host: "127.0.0.1", port: 9222 },
    });
  });

  test("rejects request-scoped daemon-side endpoint overrides", async () => {
    await expect(resolveTrustedBrowserConfig("169.254.169.254:80")).rejects.toThrow(
      "must match the trusted browser.remoteChrome endpoint",
    );
  });
});
