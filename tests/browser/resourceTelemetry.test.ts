import { describe, expect, test } from "vitest";
import {
  isProcessTerminationEligible,
  parsePosixProcessList,
  parseWindowsProcessJson,
  redactProcessCommand,
  sampleOwnedChromeTree,
  validateProcessIdentity,
} from "../../src/browser/resourceTelemetry.js";

describe("resource telemetry", () => {
  test("parses POSIX rows and aggregates an owned descendant tree", async () => {
    const rows = parsePosixProcessList(
      [
        "100  1 Mon Jan  2 03:04:05 2024 1000 2.5 00:00:01 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/profile --disable-background-networking --disable-renderer-backgrounding",
        "101 100 Mon Jan  2 03:04:05 2024 2000 1.0 00:00:02 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer",
        "102 101 Mon Jan  2 03:04:05 2024 3000 0.5 00:00:03 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=gpu-process",
        "103 100 Mon Jan  2 03:04:05 2024 4000 0.5 00:00:03 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=utility --utility-sub-type=network.mojom.NetworkService",
        "999  1 Mon Jan  2 03:04:05 2024 9000 9.0 00:00:09 unrelated-process",
      ].join("\n"),
    );
    const sample = await sampleOwnedChromeTree({
      rootPid: 100,
      generation: "generation-1",
      targetCount: 2,
      targetTypes: { page: 2 },
      now: () => new Date("2026-08-10T00:00:00.000Z"),
      provider: { listProcesses: async () => rows },
    });
    expect(sample.rootFound).toBe(true);
    expect(sample.processCount).toBe(4);
    expect(sample.processTypeCounts).toEqual({ browser: 1, renderer: 1, gpu: 1, network: 1 });
    expect(sample.rssBytes).toBe((1000 + 2000 + 3000 + 4000) * 1024);
    expect(sample.cpuPercent).toBe(4.5);
    expect(sample.targetCount).toBe(2);
    expect(sample.sampledAt).toBe("2026-08-10T00:00:00.000Z");
  });

  test("parses Windows working set and CPU identity fields", () => {
    const rows = parseWindowsProcessJson(
      JSON.stringify([
        {
          ProcessId: 41,
          ParentProcessId: 1,
          CreationDate: "20260810010101.000000-420",
          CommandLine: "chrome.exe --type=renderer",
          WorkingSetBytes: 4096,
          CpuTime100ns: 20_000_000,
        },
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pid: 41,
      ppid: 1,
      startToken: "20260810010101.000000-420",
      workingSetBytes: 4096,
      cpuTimeMs: 2000,
      processType: "renderer",
    });
  });

  test("rejects PID reuse and start-token mismatch before termination", () => {
    const expected = {
      pid: 42,
      startToken: "old-start",
      profilePath: "/tmp/profile",
      commandIncludes: ["chrome"],
      generation: "gen-1",
    } as const;
    const reused = validateProcessIdentity(
      {
        pid: 42,
        startToken: "new-start",
        command: "chrome --user-data-dir=/tmp/profile",
        generation: "gen-1",
      },
      expected,
    );
    expect(reused.eligible).toBe(false);
    expect(reused.mismatches).toContain("start-token-mismatch");
    expect(
      isProcessTerminationEligible(
        {
          pid: 42,
          startToken: "old-start",
          command: "chrome --user-data-dir=/tmp/profile",
          generation: "gen-1",
        },
        expected,
      ),
    ).toBe(true);
    expect(
      validateProcessIdentity(
        {
          pid: 42,
          startToken: "old-start",
          command: "chrome --user-data-dir=/tmp/profile",
          generation: "gen-2",
        },
        expected,
      ).mismatches,
    ).toContain("generation-mismatch");
  });

  test("redacts profile and token values from process commands", () => {
    const command =
      "chrome --user-data-dir=/Users/alice/private-profile --remote-debugging-auth-token=secret-token-value-12345678901234567890 --type=renderer";
    const redacted = redactProcessCommand(command);
    expect(redacted).toContain("--type=renderer");
    expect(redacted).not.toContain("alice");
    expect(redacted).not.toContain("secret-token-value");
  });
});
