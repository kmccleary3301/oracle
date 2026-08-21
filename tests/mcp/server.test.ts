import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pathToFileURL } from "node:url";
import {
  registerMcpTools,
  resolveMcpFileDownloadPolicy,
  shouldStartMcpServerFromModule,
} from "../../src/mcp/server.js";

afterEach(() => {
  vi.unstubAllEnvs();
});
describe("oracle-mcp module startup guard", () => {
  it("starts only when the server module is the executed entrypoint", () => {
    const serverPath = "/repo/src/mcp/server.ts";
    expect(shouldStartMcpServerFromModule(pathToFileURL(serverPath).href, serverPath)).toBe(true);
  });

  it("does not start when imported by an oracle-mcp bin shim", () => {
    expect(
      shouldStartMcpServerFromModule(
        pathToFileURL("/repo/src/mcp/server.ts").href,
        "/Users/me/.nvm/versions/node/bin/oracle-mcp",
      ),
    ).toBe(false);
  });
});

describe("oracle-mcp trusted file policy", () => {
  it("loads the output root and byte ceiling from trusted process configuration", () => {
    vi.stubEnv("ORACLE_FILE_DOWNLOAD_ROOT", "./tmp/mcp-downloads");
    vi.stubEnv("ORACLE_FILE_DOWNLOAD_MAX_BYTES", "4096");
    expect(resolveMcpFileDownloadPolicy()).toMatchObject({
      approvedOutputRoot: expect.stringMatching(/tmp[/\\\\]mcp-downloads$/),
      maxDownloadBytes: 4096,
    });
  });

  it("rejects invalid byte ceilings instead of weakening the limit", () => {
    vi.stubEnv("ORACLE_FILE_DOWNLOAD_MAX_BYTES", "unlimited");
    expect(() => resolveMcpFileDownloadPolicy()).toThrow("positive safe integer");
  });
});

describe("oracle-mcp tool registration", () => {
  it("registers ChatGPT session tools exactly once", () => {
    const server = new McpServer(
      { name: "oracle-mcp-test", version: "0.0.0" },
      { capabilities: { logging: {} } },
    );
    const registerTool = vi.spyOn(server, "registerTool");

    registerMcpTools(server);

    const names = registerTool.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => name === "chatgpt_create_session")).toHaveLength(1);
    expect(names.filter((name) => name === "chatgpt_send_turn")).toHaveLength(1);
  });
});
