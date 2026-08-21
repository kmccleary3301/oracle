import { buildBrowserConfig } from "../cli/browserConfig.js";
import { loadUserConfig } from "../config.js";
import { DEFAULT_MODEL } from "../oracle.js";
import type { BrowserAutomationConfig } from "./types.js";

/**
 * Resolves browser defaults while preventing request-scoped CDP endpoint overrides.
 * A caller may repeat the configured endpoint, but only trusted local configuration
 * can choose which daemon-side host and port Oracle connects to.
 */
export async function resolveTrustedBrowserConfig(
  requestedRemoteChrome?: string,
): Promise<BrowserAutomationConfig> {
  const { config: userConfig } = await loadUserConfig();
  const browserConfig = userConfig.browser ?? {};
  const trustedRemoteChrome = browserConfig.remoteChrome ?? null;

  if (requestedRemoteChrome) {
    const requestedConfig = await buildBrowserConfig({
      model: DEFAULT_MODEL,
      remoteChrome: requestedRemoteChrome,
    });
    const requested = requestedConfig.remoteChrome;
    if (
      !requested ||
      !trustedRemoteChrome ||
      requested.host !== trustedRemoteChrome.host ||
      requested.port !== trustedRemoteChrome.port
    ) {
      throw new Error(
        "remoteChrome must match the trusted browser.remoteChrome endpoint in Oracle configuration.",
      );
    }
  }

  return {
    ...browserConfig,
    remoteChrome: trustedRemoteChrome,
  };
}
