import { describe, expect, it } from "vitest";
import { runPackagedRollbackSmoke } from "../../scripts/packaged-rollback-smoke.mjs";

describe("packaged rollback recovery smoke", () => {
  it("observes failure, restores the previous tarball, and leaves no process or profile lock", async () => {
    await expect(runPackagedRollbackSmoke()).resolves.toMatchObject({
      passed: true,
      currentVersion: "2.0.0-current",
      restoredVersion: "1.0.0-previous",
      injectedFailureStatus: 42,
      noStaleProcess: true,
      noProfileLock: true,
    });
  }, 30_000);
});
