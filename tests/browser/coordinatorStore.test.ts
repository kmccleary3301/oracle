import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BrowserCoordinatorStore } from "../../src/browser/coordinatorStore.js";

const stores: BrowserCoordinatorStore[] = [];
const tempDirectories: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-coordinator-store-"));
  tempDirectories.push(directory);
  return path.join(directory, "profile", "coordinator.sqlite");
}

function open(
  databasePath: string,
  options: Partial<ConstructorParameters<typeof BrowserCoordinatorStore>[0]> = {},
) {
  const store = new BrowserCoordinatorStore({
    profileId: "profile-a",
    databasePath,
    targetCeilings: { total: 4, mutation: 1 },
    now: () => 1_000,
    ...options,
  });
  stores.push(store);
  return store;
}

describe("BrowserCoordinatorStore", () => {
  test("allows only one live generation owner and requires explicit stale takeover", async () => {
    const dbPath = await databasePath();
    const first = open(dbPath, { staleOwnerMs: 100 });
    const second = open(dbPath, { staleOwnerMs: 100 });

    const initial = first.claimProfileGeneration({
      ownerPid: 101,
      ownerStartToken: "owner-a",
      now: 1_000,
    });
    expect(initial).toMatchObject({ claimed: true, generation: 1, reason: "claimed" });

    expect(
      second.claimProfileGeneration({
        ownerPid: 202,
        ownerStartToken: "owner-b",
        now: 1_001,
      }),
    ).toMatchObject({ claimed: false, generation: 1, reason: "owner_active" });

    expect(
      second.claimProfileGeneration({
        ownerPid: 202,
        ownerStartToken: "owner-b",
        now: 1_200,
      }),
    ).toMatchObject({ claimed: false, generation: 1, reason: "takeover_required" });

    expect(
      second.claimProfileGeneration({
        ownerPid: 202,
        ownerStartToken: "owner-b",
        now: 1_200,
        takeover: true,
      }),
    ).toMatchObject({ claimed: true, takeover: true, generation: 2, reason: "claimed" });
  });
  test("serializes 100 concurrent two-store generation and admission races within ceilings", async () => {
    const dbPath = await databasePath();
    const ceilings = {
      total: 3,
      roles: { mutation: 1, polling: 1, recovery: 1, auth: 1 },
    };
    const first = open(dbPath, { targetCeilings: ceilings, staleOwnerMs: 10_000 });
    const second = open(dbPath, { targetCeilings: ceilings, staleOwnerMs: 10_000 });

    const claims = await Promise.all(
      Array.from({ length: 100 }, (_, index) => {
        const ownerPid = index % 2 === 0 ? 101 : 202;
        const store = ownerPid === 101 ? first : second;
        return Promise.resolve().then(() =>
          store.claimProfileGeneration({
            ownerPid,
            ownerStartToken: `owner-${ownerPid}`,
            now: 1_000 + index,
          }),
        );
      }),
    );
    const claimed = claims.filter((claim) => claim.reason === "claimed");
    expect(claimed).toHaveLength(1);
    expect(new Set(claimed.map((claim) => claim.generation))).toEqual(new Set([1]));

    const profile = first.getProfile();
    expect(profile).toMatchObject({
      generation: 1,
      state: "running",
      ownerPid: expect.any(Number),
      ownerStartToken: expect.stringMatching(/^owner-(101|202)$/),
    });
    const ownerStore = profile?.ownerPid === 101 ? first : second;
    const roles = ["mutation", "polling", "recovery", "auth"] as const;
    const admissions = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        Promise.resolve().then(() =>
          ownerStore.admitTarget({
            targetId: `race-target-${index}`,
            reservationId: `race-reservation-${index}`,
            generation: 1,
            role: roles[index % roles.length],
            now: 2_000 + index,
          }),
        ),
      ),
    );
    for (const role of roles) {
      expect(
        ownerStore.listTargets().filter((target) => target.role === role).length,
      ).toBeLessThanOrEqual(1);
    }
    expect(admissions.filter((admission) => !admission.admitted)).toHaveLength(97);
    expect(admissions.every((admission) => admission.activeTargetCount <= 3)).toBe(true);
    expect(admissions.every((admission) => admission.activeRoleCount <= 1)).toBe(true);
  });

  test("admits targets atomically at total and role ceilings", async () => {
    const dbPath = await databasePath();
    const first = open(dbPath, { targetCeilings: { total: 1, mutation: 1 } });
    const second = open(dbPath, { targetCeilings: { total: 1, mutation: 1 } });
    first.claimProfileGeneration({ ownerPid: 101, ownerStartToken: "owner-a", now: 1_000 });

    const admitted = first.admitTarget({
      targetId: "target-a",
      generation: 1,
      role: "mutation",
      now: 1_001,
    });
    const rejected = second.admitTarget({
      targetId: "target-b",
      generation: 1,
      role: "mutation",
      now: 1_002,
    });

    expect(admitted).toMatchObject({ admitted: true, reason: "admitted", activeTargetCount: 1 });
    expect(rejected).toMatchObject({
      admitted: false,
      reason: "total_ceiling",
      activeTargetCount: 1,
    });
    expect(first.listTargets()).toHaveLength(1);
  });

  test("pauses cross-process target admission at resource gates and preserves recovery access", async () => {
    const dbPath = await databasePath();
    const first = open(dbPath);
    const second = open(dbPath);
    first.claimProfileGeneration({ ownerPid: 101, ownerStartToken: "owner-a", now: 1_000 });
    const thresholds = {
      rssResumeBytes: 100,
      rssSoftBytes: 200,
      rssHardBytes: 300,
    };

    first.upsertResourceGate({
      generation: 1,
      phase: "soft",
      reason: "rss_soft_watermark",
      processTreeRssBytes: 225,
      sampledAt: 1_001,
      ...thresholds,
    });
    expect(
      second.admitTarget({
        targetId: "paused-mutation",
        generation: 1,
        role: "mutation",
        now: 1_002,
      }),
    ).toMatchObject({ admitted: false, reason: "resource_soft" });
    expect(
      second.admitTarget({
        targetId: "recovery-at-soft-limit",
        generation: 1,
        role: "recovery",
        now: 1_003,
      }),
    ).toMatchObject({ admitted: true, reason: "admitted" });

    first.upsertResourceGate({
      generation: 1,
      phase: "hard",
      reason: "rss_hard_watermark",
      processTreeRssBytes: 301,
      sampledAt: 1_004,
      ...thresholds,
    });
    expect(
      second.admitTarget({
        targetId: "recovery-at-hard-limit",
        generation: 1,
        role: "recovery",
        now: 1_005,
      }),
    ).toMatchObject({ admitted: false, reason: "resource_hard" });

    first.upsertResourceGate({
      generation: 1,
      phase: "normal",
      reason: "below_limits",
      processTreeRssBytes: 99,
      sampledAt: 1_006,
      ...thresholds,
    });
    expect(
      second.admitTarget({
        targetId: "resumed-mutation",
        generation: 1,
        role: "mutation",
        now: 1_007,
      }),
    ).toMatchObject({ admitted: true, reason: "admitted" });
    expect(first.getResourceGate()).toMatchObject({
      phase: "normal",
      processTreeRssBytes: 99,
      sampledAt: 1_006,
    });
  });

  test("binds a reserved target to its observed target atomically", async () => {
    const dbPath = await databasePath();
    const store = open(dbPath);
    store.claimProfileGeneration({ ownerPid: 101, ownerStartToken: "owner-a", now: 1_000 });

    const reservation = store.admitTarget({
      reservationId: "reservation-a",
      generation: 1,
      role: "polling",
      now: 1_001,
    });
    expect(reservation).toMatchObject({
      admitted: true,
      reservationId: "reservation-a",
      target: { targetId: "reservation-a", state: "admitted" },
    });

    const bound = store.bindTargetReservation({
      reservationId: "reservation-a",
      targetId: "observed-target-a",
      generation: 1,
      url: "https://chatgpt.com/c/test",
      now: 1_002,
    });
    expect(bound).toMatchObject({
      bound: true,
      reason: "bound",
      target: {
        targetId: "observed-target-a",
        reservationId: "reservation-a",
        state: "active",
      },
    });
    expect(
      store.bindTargetReservation({
        reservationId: "reservation-a",
        targetId: "different-target",
        generation: 1,
        now: 1_003,
      }),
    ).toMatchObject({ bound: false, reason: "already_bound" });
  });

  test("releases ownership for immediate reclaim and ignores stale-generation targets", async () => {
    const dbPath = await databasePath();
    const first = open(dbPath, {
      staleOwnerMs: 10_000,
      targetCeilings: { total: 1, mutation: 1 },
    });
    const second = open(dbPath, {
      staleOwnerMs: 10_000,
      targetCeilings: { total: 1, mutation: 1 },
    });
    first.claimProfileGeneration({
      ownerPid: 101,
      ownerStartToken: "owner-a",
      browserPid: 300,
      devtoolsEndpoint: "127.0.0.1:9222",
      now: 1_000,
    });
    expect(
      first.admitTarget({
        targetId: "stale-generation-target",
        generation: 1,
        role: "mutation",
        now: 1_000,
      }),
    ).toMatchObject({ admitted: true });
    expect(
      first.releaseProfile({
        ownerPid: 101,
        ownerStartToken: "owner-a",
        generation: 1,
      }),
    ).toBe(true);
    expect(first.getProfile()).toMatchObject({
      state: "stopped",
      ownerPid: null,
      browserPid: null,
      devtoolsEndpoint: null,
      heartbeatAt: null,
    });

    const reclaimed = second.claimProfileGeneration({
      ownerPid: 202,
      ownerStartToken: "owner-b",
      now: 1_001,
    });
    expect(reclaimed).toMatchObject({ claimed: true, generation: 2, takeover: true });
    expect(
      second.admitTarget({
        targetId: "new-generation-target",
        generation: 2,
        role: "mutation",
        now: 1_002,
      }),
    ).toMatchObject({ admitted: true, activeTargetCount: 1 });
  });

  test("rejects stale CAS transitions and keeps event sequence and timestamps monotonic", async () => {
    const dbPath = await databasePath();
    const store = open(dbPath);
    store.claimProfileGeneration({ ownerPid: 101, ownerStartToken: "owner-a", now: 1_000 });
    const job = store.createJob({
      jobId: "job-cas",
      operation: "chat",
      ownerGeneration: 1,
      ownerLeaseId: "lease-a",
      idempotencyKey: "request-a",
      attempt: 1,
      now: 1_010,
    });

    expect(
      store.transitionJob({
        jobId: job.jobId,
        expectedState: "queued",
        nextState: "running",
        expectedOwnerGeneration: 1,
        expectedOwnerLeaseId: "lease-a",
        now: 1_020,
      }),
    ).toMatchObject({ state: "running", attempt: 1 });
    expect(
      store.transitionJob({
        jobId: job.jobId,
        expectedState: "queued",
        nextState: "requires_action",
        expectedOwnerGeneration: 1,
        expectedOwnerLeaseId: "lease-a",
        now: 1_030,
      }),
    ).toBeNull();

    store.appendJobEvent({
      jobId: job.jobId,
      state: "running",
      reasonCode: "late-observation",
      timestamp: 900,
    });
    const events = store.listJobEvents(job.jobId);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.timestamp)).toEqual([1_010, 1_020, 1_020]);
    expect(store.getJobByIdempotencyKey("request-a")?.jobId).toBe(job.jobId);
  });

  test("persists metadata and bounded samples across clean restart", async () => {
    const dbPath = await databasePath();
    const first = open(dbPath, { maxResourceSamples: 2 });
    first.claimProfileGeneration({
      ownerPid: 101,
      ownerStartToken: "owner-a",
      now: 1_000,
      browserPid: 300,
      devtoolsEndpoint: "127.0.0.1:9222",
    });
    const job = first.createJob({ jobId: "job-persist", operation: "upload", now: 1_001 });
    first.addAttachment({
      jobId: job.jobId,
      attachmentId: "attachment-a",
      path: "/tmp/input.png",
      size: 42,
      mediaType: "image/png",
      sha256: "hash",
    });
    first.addArtifact({
      jobId: job.jobId,
      artifactId: "artifact-a",
      kind: "image",
      path: "/tmp/output.png",
      size: 84,
      sha256: "artifact-hash",
    });
    first.upsertRateLimit({ key: "chatgpt", remaining: 2, resetAt: 2_000, now: 1_002 });
    first.appendResourceSample({ processTreeRssBytes: 10, sampledAt: 1_003 });
    first.appendResourceSample({ processTreeRssBytes: 20, sampledAt: 1_004 });
    first.appendResourceSample({ processTreeRssBytes: 30, sampledAt: 1_005 });
    first.upsertResourceGate({
      generation: 1,
      phase: "soft",
      reason: "rss_soft_watermark",
      processTreeRssBytes: 30,
      rssResumeBytes: 10,
      rssSoftBytes: 20,
      rssHardBytes: 40,
      sampledAt: 1_006,
    });
    first.close();

    const restarted = open(dbPath, { maxResourceSamples: 2 });
    expect(restarted.getProfile()).toMatchObject({
      generation: 1,
      ownerPid: 101,
      browserPid: 300,
    });
    expect(restarted.getJob("job-persist")?.operation).toBe("upload");
    expect(restarted.listAttachments("job-persist")).toHaveLength(1);
    expect(restarted.listArtifacts("job-persist")).toHaveLength(1);
    expect(restarted.getRateLimit("chatgpt")?.remaining).toBe(2);
    expect(restarted.listResourceSamples()).toHaveLength(2);
    expect(restarted.listResourceSamples().map((sample) => sample.processTreeRssBytes)).toEqual([
      30, 20,
    ]);
    expect(restarted.getResourceGate()).toMatchObject({
      generation: 1,
      phase: "soft",
      reason: "rss_soft_watermark",
      processTreeRssBytes: 30,
    });
  });

  test("rejects incomplete schema instead of silently migrating it", async () => {
    const dbPath = await databasePath();
    const first = open(dbPath);
    first.close();
    const db = new DatabaseSync(dbPath);
    db.exec("DROP TABLE jobs;");
    db.close();
    expect(() => open(dbPath)).toThrow(/missing table jobs|unsupported schema/i);
  });

  test("migrates version-one coordinator databases without losing state", async () => {
    const dbPath = await databasePath();
    const first = open(dbPath);
    first.claimProfileGeneration({ ownerPid: 101, ownerStartToken: "owner-a", now: 1_000 });
    first.close();
    const db = new DatabaseSync(dbPath);
    db.exec(`
      DROP TABLE resource_gate;
      UPDATE schema_meta SET version = 1;
      PRAGMA user_version = 1;
    `);
    db.close();

    const migrated = open(dbPath);
    expect(migrated.getProfile()).toMatchObject({ ownerPid: 101, generation: 1 });
    expect(migrated.getResourceGate()).toBeNull();
    const versionDb = new DatabaseSync(dbPath);
    const versionRow = versionDb.prepare("PRAGMA user_version").get();
    const userVersion =
      versionRow && "user_version" in versionRow ? versionRow.user_version : undefined;
    expect(userVersion).toBe(2);
    versionDb.close();
  });
});
