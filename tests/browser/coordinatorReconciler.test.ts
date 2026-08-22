import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserCoordinatorStore } from "../../src/browser/coordinatorStore.js";
import { reconcileCoordinatorOwnership } from "../../src/browser/coordinatorReconciler.js";
import type {
  ProcessSnapshot,
  ProcessSnapshotProvider,
} from "../../src/browser/resourceTelemetry.js";

const stores: BrowserCoordinatorStore[] = [];
const directories: string[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-coordinator-reconciler-"));
  directories.push(directory);
  return path.join(directory, "coordinator.sqlite");
}

function snapshot(
  input: Partial<ProcessSnapshot> & Pick<ProcessSnapshot, "pid" | "startToken" | "command">,
): ProcessSnapshot {
  return {
    pid: input.pid,
    ppid: input.ppid ?? null,
    startToken: input.startToken,
    rssBytes: null,
    workingSetBytes: null,
    cpuPercent: null,
    cpuTimeMs: null,
    command: input.command,
    processType: input.processType ?? "other",
    generation: input.generation,
  };
}

function provider(processes: readonly ProcessSnapshot[]): ProcessSnapshotProvider {
  return { listProcesses: async () => processes };
}

async function runningStore(
  options: { profilePath?: string; browserPid?: number | null; endpoint?: string | null } = {},
) {
  const databasePathValue = await databasePath();
  const store = new BrowserCoordinatorStore({
    profileId: "profile-a",
    profilePath: options.profilePath,
    databasePath: databasePathValue,
    staleOwnerMs: 30_000,
    now: () => 0,
  });
  stores.push(store);
  store.claimProfileGeneration({
    ownerPid: 101,
    ownerStartToken: "owner-a",
    browserPid: options.browserPid === undefined ? 303 : options.browserPid,
    devtoolsEndpoint: options.endpoint === undefined ? "127.0.0.1:9222" : options.endpoint,
    now: 0,
  });
  return store;
}

function ownerProcess(profilePath?: string, startToken = "owner-a") {
  return snapshot({
    pid: 101,
    startToken,
    command: `node --generation=1${profilePath ? ` --user-data-dir=${profilePath}` : ""}`,
    generation: "1",
  });
}

function browserProcess(profilePath?: string, startToken = "owner-a") {
  return snapshot({
    pid: 303,
    startToken,
    command: `chrome --generation=1${profilePath ? ` --user-data-dir=${profilePath}` : ""}`,
    processType: "browser",
    generation: "1",
  });
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("reconcileCoordinatorOwnership", () => {
  test("requires owner process observation when a stale heartbeat cannot be checked", async () => {
    const store = await runningStore({ browserPid: null, endpoint: null });
    const result = await reconcileCoordinatorOwnership({
      store,
      now: () => 30_000,
      processProvider: {
        listProcesses: async () => {
          throw new Error("process list unavailable");
        },
      },
      endpointProbe: async () => ({ ok: false, error: "offline" }),
    });

    expect(result).toMatchObject({
      classification: "degraded",
      takeoverAllowed: false,
      terminationAllowed: false,
      requiresAction: true,
      generation: 1,
      endpointReachable: null,
    });
    expect(result.reasons).toEqual(["heartbeat-stale", "process-observation-unavailable"]);
  });

  test("adopts stale ownership only with matching PID/start-token evidence", async () => {
    const store = await runningStore();
    const observations = provider([ownerProcess(), browserProcess()]);
    const beforeDeadline = await reconcileCoordinatorOwnership({
      store,
      now: () => 29_999,
      processProvider: observations,
      endpointProbe: async () => ({ ok: true }),
    });
    expect(beforeDeadline).toMatchObject({
      classification: "healthy",
      takeoverAllowed: false,
      requiresAction: false,
    });
    const result = await reconcileCoordinatorOwnership({
      store,
      now: () => 30_000,
      processProvider: observations,
      endpointProbe: async () => ({ ok: true }),
    });

    expect(result).toMatchObject({
      classification: "adoptable-owned",
      takeoverAllowed: true,
      terminationAllowed: false,
      requiresAction: false,
      generation: 1,
      endpointReachable: true,
      ownerValidation: { eligible: true, mismatches: [] },
      browserValidation: { eligible: true, mismatches: [] },
    });
    expect(result.reasons).toEqual(["heartbeat-stale", "devtools-reachable"]);
  });

  test("accepts a conclusively absent owner when the process listing proves browser identity", async () => {
    const store = await runningStore();
    const result = await reconcileCoordinatorOwnership({
      store,
      now: () => 30_000,
      processProvider: provider([browserProcess()]),
      endpointProbe: async () => ({ ok: true }),
    });

    expect(result).toMatchObject({
      classification: "adoptable-owned",
      takeoverAllowed: true,
      terminationAllowed: false,
      requiresAction: false,
      ownerValidation: null,
      browserValidation: { eligible: true },
    });
  });

  test("rejects PID reuse and start-token mismatch without authorizing termination", async () => {
    const store = await runningStore();
    const terminate = vi.fn();
    const result = await reconcileCoordinatorOwnership({
      store,
      now: () => 30_000,
      processProvider: provider([ownerProcess(undefined, "owner-b-reused"), browserProcess()]),
      endpointProbe: async () => ({ ok: true }),
    });

    expect(result).toMatchObject({
      classification: "degraded",
      takeoverAllowed: false,
      terminationAllowed: false,
      requiresAction: true,
      ownerValidation: { eligible: false },
    });
    expect(result.reasons).toEqual([
      "heartbeat-stale",
      "start-token-mismatch",
      "devtools-reachable",
    ]);
    if (result.terminationAllowed) terminate();
    expect(terminate).not.toHaveBeenCalled();
  });

  test("marks endpoint-unreachable ownership as degraded and preserves profile state", async () => {
    const profilePath = await mkdtemp(path.join(os.tmpdir(), "oracle-coordinator-profile-"));
    directories.push(profilePath);
    await writeFile(path.join(profilePath, "keep-me"), "profile");
    const store = await runningStore({ profilePath });
    const terminate = vi.fn();
    const result = await reconcileCoordinatorOwnership({
      store,
      now: () => 30_000,
      processProvider: provider([ownerProcess(profilePath), browserProcess(profilePath)]),
      endpointProbe: async () => ({ ok: false, error: "connection-refused" }),
    });

    expect(result).toMatchObject({
      classification: "degraded",
      takeoverAllowed: false,
      terminationAllowed: false,
      requiresAction: true,
      endpointReachable: false,
    });
    expect(result.reasons).toEqual(["heartbeat-stale", "devtools-unreachable"]);
    if (result.terminationAllowed) terminate();
    expect(terminate).not.toHaveBeenCalled();
    expect(store.getProfile()).toMatchObject({ state: "running", ownerPid: 101, browserPid: 303 });
    await expect(
      writeFile(path.join(profilePath, "keep-me"), "preserved"),
    ).resolves.toBeUndefined();
  });

  test("returns terminal-owned only after the owner and browser are observably gone", async () => {
    const store = await runningStore({ browserPid: null, endpoint: null });
    const result = await reconcileCoordinatorOwnership({
      store,
      now: () => 30_000,
      processProvider: provider([]),
      endpointProbe: async () => ({ ok: false, error: "offline" }),
    });

    expect(result).toMatchObject({
      classification: "terminal-owned",
      takeoverAllowed: true,
      terminationAllowed: false,
      requiresAction: false,
      endpointReachable: null,
    });
    expect(result.reasons).toEqual(["heartbeat-stale"]);
  });

  test("adopted remote targets are detach-only", async () => {
    const store = await runningStore();
    const result = await reconcileCoordinatorOwnership({
      store,
      now: () => 30_000,
      processProvider: provider([ownerProcess(), browserProcess()]),
      endpointProbe: async () => ({ ok: true }),
      remote: true,
    });

    expect(result).toMatchObject({
      classification: "remote-detach-only",
      takeoverAllowed: true,
      terminationAllowed: false,
      requiresAction: false,
    });
  });

  test("adopts a self-launched endpoint when the stale claim has no observable owner or browser", async () => {
    const store = await runningStore({ browserPid: null });
    const result = await reconcileCoordinatorOwnership({
      store,
      now: () => 30_000,
      processProvider: provider([]),
      endpointProbe: async () => ({ ok: true }),
      selfLaunchedEndpoint: true,
    });

    expect(result).toMatchObject({
      classification: "adoptable-owned",
      takeoverAllowed: true,
      terminationAllowed: false,
      requiresAction: false,
      generation: 1,
      endpointReachable: true,
    });
    expect(result.reasons).toEqual(["heartbeat-stale", "devtools-reachable"]);
  });

  test("keeps degraded classification for self-launched endpoints in remote mode", async () => {
    const store = await runningStore({ browserPid: null });
    const result = await reconcileCoordinatorOwnership({
      store,
      now: () => 30_000,
      processProvider: provider([]),
      endpointProbe: async () => ({ ok: true }),
      selfLaunchedEndpoint: true,
      remote: true,
    });

    expect(result).toMatchObject({
      classification: "degraded",
      takeoverAllowed: false,
      requiresAction: true,
    });
  });

  test("recognizes a stopped profile as terminal without a process action", async () => {
    const store = await runningStore({ browserPid: null, endpoint: null });
    expect(store.releaseProfile({ ownerPid: 101, ownerStartToken: "owner-a", generation: 1 })).toBe(
      true,
    );

    const result = await reconcileCoordinatorOwnership({
      store,
      now: () => 30_000,
      processProvider: provider([]),
    });
    expect(result).toMatchObject({
      classification: "terminal-owned",
      takeoverAllowed: true,
      terminationAllowed: false,
      requiresAction: false,
      reasons: ["profile-stopped"],
    });
  });
});
