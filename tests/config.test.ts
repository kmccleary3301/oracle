import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadUserConfig } from "../src/config.js";
import { resolveOracleDaemonConfig } from "../src/daemon/config.js";
import { setOracleHomeDirOverrideForTest } from "../src/oracleHome.js";

describe("loadUserConfig", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-config-"));
    setOracleHomeDirOverrideForTest(tempDir);
  });

  it("parses JSON5 config with comments", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(
      configPath,
      `// comment\n{
        engine: "browser",
        notify: { sound: true },
        heartbeatSeconds: 15,
        maxFileSizeBytes: 2097152,
        browser: { remoteHost: "host:1234", remoteToken: "abc" },
      }`,
      "utf8",
    );

    const result = await loadUserConfig();
    expect(result.loaded).toBe(true);
    expect(result.config.engine).toBe("browser");
    expect(result.config.notify?.sound).toBe(true);
    expect(result.config.heartbeatSeconds).toBe(15);
    expect(result.config.maxFileSizeBytes).toBe(2097152);
    expect(result.config.browser?.remoteHost).toBe("host:1234");
    expect(result.config.browser?.remoteToken).toBe("abc");
  });

  it("supports browser remote defaults", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(
      configPath,
      `{
        browser: { remoteHost: "alias:9999", remoteToken: "secret" }
      }`,
      "utf8",
    );

    const result = await loadUserConfig();
    expect(result.loaded).toBe(true);
    expect(result.config.browser?.remoteHost).toBe("alias:9999");
    expect(result.config.browser?.remoteToken).toBe("secret");
  });

  it("returns empty config when file is missing", async () => {
    const result = await loadUserConfig();
    expect(result.loaded).toBe(false);
    expect(result.config).toEqual({});
  });

  it("resolves daemon config defaults and overrides", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(
      configPath,
      `{
        daemon: {
          host: "127.0.0.2",
          port: 9555,
          connectionPath: "/tmp/oracle-daemon.json",
          jobDir: "/tmp/oracle-jobs",
          maxConcurrentJobs: 2,
          maxOpenChatgptTabs: 3,
        }
      }`,
      "utf8",
    );

    const resolved = await resolveOracleDaemonConfig();
    expect(resolved.host).toBe("127.0.0.2");
    expect(resolved.port).toBe(9555);
    expect(resolved.connectionPath).toBe("/tmp/oracle-daemon.json");
    expect(resolved.jobDir).toBe("/tmp/oracle-jobs");
    expect(resolved.maxConcurrentJobs).toBe(2);
    expect(resolved.maxOpenChatgptTabs).toBe(3);
  });

  afterAll(() => {
    setOracleHomeDirOverrideForTest(null);
  });
});
