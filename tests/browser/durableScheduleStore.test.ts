import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalGrantAuthority } from "../../src/browser/approvalToken.js";
import {
  ChatgptScheduleService,
  chatgptScheduleApprovalChallengeForTest,
} from "../../src/browser/chatgpt/schedules.js";
import { DurableChatgptScheduleStore } from "../../src/browser/chatgpt/durableScheduleStore.js";
import type {
  ChatgptScheduleDriver,
  ChatgptScheduleRecord,
} from "../../src/browser/chatgpt/scheduleTypes.js";

const directories: string[] = [];
const record = (overrides: Partial<ChatgptScheduleRecord> = {}): ChatgptScheduleRecord => ({
  scheduleId: "schedule-1",
  revisionHash: "revision-1",
  title: "Daily report",
  prompt: "Report status",
  recurrence: { kind: "daily", hour: 9, minute: 0, timezone: "UTC" },
  state: "active",
  observedEvidence: true,
  provenance: [],
  ...overrides,
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-schedule-store-"));
  directories.push(directory);
  return path.join(directory, "schedules.sqlite");
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("durable ChatGPT schedule desired state", () => {
  it("restores desired state after closing and reopening the SQLite store", async () => {
    const file = await databasePath();
    const first = new DurableChatgptScheduleStore(file);
    first.save(record({ desiredState: "paused" }));
    first.close();

    const restarted = new DurableChatgptScheduleStore(file);
    expect(restarted.load()).toEqual([record({ desiredState: "paused" })]);
    expect(restarted.snapshot("schedule-1")?.desiredState).toBe("paused");
    restarted.close();
  });

  it("allows one CAS winner and rejects stale revisions", async () => {
    const file = await databasePath();
    const store = new DurableChatgptScheduleStore(file);
    expect(store.compareAndSwap("schedule-1", null, record())).toBe(true);
    expect(store.compareAndSwap("schedule-1", null, record({ revisionHash: "revision-2" }))).toBe(
      false,
    );
    expect(
      store.saveIfRevision(record({ revisionHash: "revision-2", state: "paused" }), "revision-1"),
    ).toBe(true);
    expect(
      store.saveIfRevision(record({ revisionHash: "revision-3", state: "deleted" }), "revision-1"),
    ).toBe(false);
    expect(store.get("schedule-1")?.revisionHash).toBe("revision-2");
    store.close();
  });

  it("serializes two controllers so reconciliation mutates once", async () => {
    const file = await databasePath();
    const storeA = new DurableChatgptScheduleStore(file);
    const storeB = new DurableChatgptScheduleStore(file);
    let remote = record({ desiredState: "paused" });
    let pauseCalls = 0;
    const driver: ChatgptScheduleDriver = {
      list: async () => [remote],
      get: async () => remote,
      create: async () => remote,
      update: async () => remote,
      pause: async () => {
        pauseCalls += 1;
        remote = { ...remote, state: "paused", revisionHash: "revision-2" };
        return remote;
      },
      resume: async () => remote,
      delete: async () => ({ ...remote, state: "deleted", revisionHash: "revision-3" }),
    };
    storeA.save(record({ desiredState: "paused" }));
    const first = new ChatgptScheduleService(driver, storeA);
    const second = new ChatgptScheduleService(driver, storeB);
    const [a, b] = await Promise.all([first.reconcile(), second.reconcile()]);
    expect(pauseCalls).toBe(1);
    expect([a.state, b.state].every((state) => state === "ok")).toBe(true);
    expect(storeB.get("schedule-1")?.state).toBe("paused");
    storeA.close();
    storeB.close();
  });

  it("reports external drift as a conflict without mutating the drifted schedule", async () => {
    const file = await databasePath();
    const store = new DurableChatgptScheduleStore(file);
    store.save(record({ desiredState: "paused" }));
    let pauseCalls = 0;
    const remote = record({ revisionHash: "revision-external", state: "active" });
    const driver: ChatgptScheduleDriver = {
      list: async () => [remote],
      get: async () => remote,
      create: async () => remote,
      update: async () => remote,
      pause: async () => {
        pauseCalls += 1;
        return remote;
      },
      resume: async () => remote,
      delete: async () => remote,
    };
    const result = await new ChatgptScheduleService(driver, store).reconcile();
    expect(result.state).toBe("requires_action");
    expect(result.conflicts).toMatchObject([
      {
        reason: "external-drift",
        expectedRevisionHash: "revision-1",
        observedRevisionHash: "revision-external",
      },
    ]);
    expect(pauseCalls).toBe(0);
    store.close();
  });

  it("preserves terminal intent and handles cancellation without a mutation", async () => {
    const file = await databasePath();
    const store = new DurableChatgptScheduleStore(file);
    store.save(record());
    expect(store.markTerminal("schedule-1", "completed", "revision-1")).toBe(true);
    expect(store.get("schedule-1")?.desiredState).toBe("completed");
    let mutations = 0;
    const driver: ChatgptScheduleDriver = {
      list: async () => [record()],
      get: async () => record(),
      create: async () => record(),
      update: async () => record(),
      pause: async () => {
        mutations += 1;
        return record({ state: "paused" });
      },
      resume: async () => {
        mutations += 1;
        return record({ state: "active" });
      },
      delete: async () => {
        mutations += 1;
        return record({ state: "deleted" });
      },
    };
    const controller = new AbortController();
    controller.abort();
    const result = await new ChatgptScheduleService(driver, store).reconcile(controller.signal);
    expect(result.state).toBe("requires_action");
    expect(result.requiresAction).toMatchObject([{ reason: "cancellation-race" }]);
    expect(mutations).toBe(0);
    store.close();
  });

  it("keeps schedule approvals bound to the durable observed revision", () => {
    const authority = new ApprovalGrantAuthority({ dbPath: ":memory:" });
    const approvalChallenge = chatgptScheduleApprovalChallengeForTest(
      "chatgpt.schedule.pause",
      "schedule-1",
      "revision-1",
    );
    const issued = authority.issueGrant(approvalChallenge, { localOperator: true });
    expect(issued.state).toBe("issued");
    if (issued.state === "issued") {
      expect(authority.consumeGrant(issued.grant, approvalChallenge).state).toBe("consumed");
    }
    authority.close();
  });
});
