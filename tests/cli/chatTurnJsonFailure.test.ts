import { describe, expect, test } from "vitest";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = path.join(process.cwd(), "bin", "oracle-cli.ts");

describe("chat turn JSON failures", () => {
  test("emits structured JSON when pre-submit browser setup fails", async () => {
    await expect(
      execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "chat",
          "turn",
          "https://chatgpt.com/c/test",
          "--turn-message",
          "hello",
          "--remote-chrome",
          "127.0.0.1:1",
          "--json",
        ],
        {
          env: {
            ...process.env,
            // biome-ignore lint/style/useNamingConvention: env var name
            ORACLE_DISABLE_KEYTAR: "1",
          },
        },
      ),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('"status": "failed"'),
    });
  });
});
