import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApprovalGrantAuthority,
  approvalChallengeDigest,
  createApprovalChallenge,
  serializeApprovalChallenge,
} from "../../src/browser/approvalToken.js";

const now = 1_800_000_000_000;
const challenge = createApprovalChallenge({
  operation: "chatgpt.schedule.pause",
  target: "schedule-1",
  revision: "revision-1",
  payload: { scheduleId: "schedule-1", state: "paused" },
  expiry: now + 60_000,
});
const paths: string[] = [];

function newAuthority(clock = now): ApprovalGrantAuthority {
  const directory = join(tmpdir(), `oracle-approval-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const dbPath = join(directory, "grants.sqlite");
  paths.push(directory);
  return new ApprovalGrantAuthority({ dbPath, now: () => clock });
}

afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("approval grants", () => {
  it("returns a canonical challenge and no grant from preview construction", () => {
    expect(serializeApprovalChallenge(challenge)).toBe(
      '{"expiry":1800000060000,"operation":"chatgpt.schedule.pause","payloadDigest":"8ac16edcf75d7cb95c550e995cef311a23ac58146d62c71eab5ce4bfae08d345","revision":"revision-1","target":"schedule-1"}',
    );
    expect(approvalChallengeDigest(challenge)).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(challenge)).not.toMatch(/grant/i);
  });

  it("requires host confirmation and stores only a random opaque grant hash", () => {
    const authority = newAuthority();
    const unconfirmed = authority.issueGrant(challenge);
    expect(unconfirmed.state).toBe("requires_action");
    if (unconfirmed.state === "requires_action") {
      expect(unconfirmed.reason).toBe("operator-confirmation-required");
    }
    const issued = authority.issueGrant(challenge, {
      confirmed: true,
      principal: "user-1",
      session: "session-1",
    });
    expect(issued.state).toBe("issued");
    if (issued.state !== "issued") return;
    expect(issued.grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.grant).not.toContain(approvalChallengeDigest(challenge));
    authority.close();
  });

  it("binds operation, target, revision, payload, principal, and session", () => {
    const authority = newAuthority();
    const issued = authority.issueGrant(challenge, {
      confirmed: true,
      principal: "user-1",
      session: "session-1",
    });
    expect(issued.state).toBe("issued");
    if (issued.state !== "issued") return;
    const mismatchedOperation = authority.consumeGrant(
      issued.grant,
      { ...challenge, operation: "other" },
      { principal: "user-1", session: "session-1" },
    );
    expect(mismatchedOperation.state).toBe("requires_action");
    if (mismatchedOperation.state === "requires_action") {
      expect(mismatchedOperation.reason).toBe("approval-grant-mismatch");
    }
    const mismatchedPrincipal = authority.consumeGrant(issued.grant, challenge, {
      principal: "other",
      session: "session-1",
    });
    expect(mismatchedPrincipal.state).toBe("requires_action");
    if (mismatchedPrincipal.state === "requires_action") {
      expect(mismatchedPrincipal.reason).toBe("approval-principal-mismatch");
    }
    const mismatchedSession = authority.consumeGrant(issued.grant, challenge, {
      principal: "user-1",
      session: "other",
    });
    expect(mismatchedSession.state).toBe("requires_action");
    if (mismatchedSession.state === "requires_action") {
      expect(mismatchedSession.reason).toBe("approval-session-mismatch");
    }
    expect(
      authority.consumeGrant(issued.grant, challenge, { principal: "user-1", session: "session-1" })
        .state,
    ).toBe("consumed");
    const replayed = authority.consumeGrant(issued.grant, challenge, {
      principal: "user-1",
      session: "session-1",
    });
    expect(replayed.state).toBe("requires_action");
    if (replayed.state === "requires_action") {
      expect(replayed.reason).toBe("approval-grant-replayed");
    }
    authority.close();
  });

  it("consumes one grant once under 100 concurrent callers", async () => {
    const authority = newAuthority();
    const issued = authority.issueGrant(challenge, { confirmed: true });
    expect(issued.state).toBe("issued");
    if (issued.state !== "issued") return;
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        Promise.resolve(authority.consumeGrant(issued.grant, challenge)),
      ),
    );
    expect(results.filter((result) => result.state === "consumed")).toHaveLength(1);
    expect(results.filter((result) => result.state === "requires_action")).toHaveLength(99);
    authority.close();
  });

  it("persists grants across authority restart and rejects expired grants", () => {
    const directory = join(tmpdir(), `oracle-approval-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const dbPath = join(directory, "grants.sqlite");
    paths.push(directory);
    const first = new ApprovalGrantAuthority({ dbPath, now: () => now });
    const issued = first.issueGrant(challenge, { localOperator: true });
    expect(issued.state).toBe("issued");
    if (issued.state !== "issued") return;
    first.close();
    const restarted = new ApprovalGrantAuthority({ dbPath, now: () => now });
    expect(restarted.consumeGrant(issued.grant, challenge).state).toBe("consumed");
    restarted.close();

    const expiring = new ApprovalGrantAuthority({
      dbPath: join(directory, "expiry.sqlite"),
      now: () => now,
    });
    const short = createApprovalChallenge({ ...challenge, expiry: now + 1 });
    const shortIssued = expiring.issueGrant(short, { localOperator: true });
    expect(shortIssued.state).toBe("issued");
    if (shortIssued.state === "issued") {
      const expired = new ApprovalGrantAuthority({
        dbPath: join(directory, "expiry.sqlite"),
        now: () => now + 1,
      });
      const consumed = expired.consumeGrant(shortIssued.grant, short);
      expect(consumed.state).toBe("requires_action");
      if (consumed.state === "requires_action") {
        expect(consumed.reason).toBe("approval-challenge-expired");
      }
      expired.close();
    }
    expiring.close();
  });
});
