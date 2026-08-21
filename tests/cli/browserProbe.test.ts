import { promisify } from "node:util";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = path.join(process.cwd(), "bin", "oracle-cli.ts");

describe("browser probe CLI", () => {
  it("registers browser probe help and JSON options", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", CLI_ENTRY, "browser", "probe", "--help"],
      { timeout: 15_000, maxBuffer: 128 * 1024 },
    );
    const help = `${stdout}\n${stderr}`;
    expect(help).toContain("browser probe");
    expect(help).toContain("--json");
    expect(help).toContain("--remote-chrome");
    expect(help).toContain("--keep-tab");
  });
});
