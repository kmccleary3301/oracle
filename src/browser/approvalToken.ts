import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const GRANT_BYTES = 32;
const GRANT_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const HEX_FORMAT = /^[0-9a-f]{64}$/;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface ApprovalChallengeInput {
  operation: string;
  target: string;
  revision: string;
  payload?: unknown;
  payloadDigest?: string;
  expiry?: number;
}

/** The complete action description returned by a preview; it never contains a grant. */
export interface ApprovalChallenge {
  operation: string;
  target: string;
  revision: string;
  payloadDigest: string;
  expiry: number;
}

/**
 * Preserves a preview challenge's expiry only when its immutable action
 * identity matches the challenge computed at the execution boundary.
 */
export function bindApprovalChallenge(
  expected: ApprovalChallenge,
  supplied?: ApprovalChallenge,
): ApprovalChallenge {
  if (
    supplied?.operation === expected.operation &&
    supplied.target === expected.target &&
    supplied.revision === expected.revision &&
    supplied.payloadDigest === expected.payloadDigest
  ) {
    return supplied;
  }
  return expected;
}

export interface ApprovalIdentity {
  principal?: string | null;
  session?: string | null;
}

export interface ApprovalGrantIssueOptions extends ApprovalIdentity {
  /** Result of an interactive host confirmation. */
  confirmed?: boolean;
  /** Explicit local-operator override for non-interactive host invocations. */
  localOperator?: boolean;
}

export type ApprovalGrantIssueResult =
  | { state: "issued"; grant: string; challenge: ApprovalChallenge }
  | ApprovalRequiresAction;

export type ApprovalGrantConsumeResult =
  | { state: "consumed"; challenge: ApprovalChallenge }
  | ApprovalRequiresAction;

export type ApprovalFailureReason =
  | "approval-authority-unavailable"
  | "operator-confirmation-required"
  | "approval-challenge-invalid"
  | "approval-challenge-expired"
  | "approval-grant-unknown"
  | "approval-grant-mismatch"
  | "approval-grant-expired"
  | "approval-grant-replayed"
  | "approval-principal-mismatch"
  | "approval-session-mismatch";

/** A typed, fail-closed result. It deliberately has no grant field. */
export interface ApprovalRequiresAction {
  state: "requires_action";
  reason: ApprovalFailureReason;
}

export interface ApprovalGrantAuthorityOptions {
  /** SQLite file. Pass `:memory:` only for isolated tests. */
  dbPath: string;
  /** Clock in Unix milliseconds, injectable for deterministic expiry tests. */
  now?: () => number;
  defaultTtlMs?: number;
}

export class ApprovalAuthorityError extends Error {
  readonly code: ApprovalFailureReason;

  constructor(code: ApprovalFailureReason, message: string) {
    super(message);
    this.name = "ApprovalAuthorityError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** JSON canonicalization with sorted object keys and explicit type boundaries. */
function canonicalJson(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null || typeof value === "undefined") return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new ApprovalAuthorityError(
        "approval-challenge-invalid",
        "Approval payload numbers must be finite.",
      );
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return `{"$bigint":${JSON.stringify(value.toString())}}`;
  if (typeof value === "function" || typeof value === "symbol")
    throw new ApprovalAuthorityError(
      "approval-challenge-invalid",
      "Approval payload is not JSON-serializable.",
    );
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()))
      throw new ApprovalAuthorityError(
        "approval-challenge-invalid",
        "Approval payload contains an invalid date.",
      );
    return JSON.stringify(value.toISOString());
  }
  if (seen.has(value))
    throw new ApprovalAuthorityError(
      "approval-challenge-invalid",
      "Approval payload cannot contain cycles.",
    );
  seen.add(value);
  try {
    if (Array.isArray(value))
      return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    if (!isRecord(value))
      throw new ApprovalAuthorityError(
        "approval-challenge-invalid",
        "Approval payload is not JSON-serializable.",
      );
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized)
    throw new ApprovalAuthorityError(
      "approval-challenge-invalid",
      `Approval challenge ${field} must not be empty.`,
    );
  return normalized;
}

function normalizeExpiry(expiry: number): number {
  if (!Number.isSafeInteger(expiry) || expiry <= 0)
    throw new ApprovalAuthorityError(
      "approval-challenge-invalid",
      "Approval challenge expiry must be a positive Unix timestamp in milliseconds.",
    );
  return expiry;
}

function normalizeDigest(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!HEX_FORMAT.test(normalized))
    throw new ApprovalAuthorityError(
      "approval-challenge-invalid",
      "Approval payloadDigest must be a SHA-256 hex digest.",
    );
  return normalized;
}

function challengeValue(input: ApprovalChallengeInput): ApprovalChallenge {
  const operation = normalizeText(input.operation, "operation");
  const target = normalizeText(input.target, "target");
  const revision = normalizeText(input.revision, "revision");
  const payloadDigest =
    input.payloadDigest === undefined
      ? digest(canonicalJson(input.payload))
      : normalizeDigest(input.payloadDigest);
  const expiry = normalizeExpiry(input.expiry ?? Date.now() + DEFAULT_TTL_MS);
  return Object.freeze({ operation, target, revision, payloadDigest, expiry });
}

export function serializeApprovalChallenge(challenge: ApprovalChallenge): string {
  return canonicalJson(challengeValue(challenge));
}

export function approvalChallengeDigest(challenge: ApprovalChallenge): string {
  return digest(serializeApprovalChallenge(challenge));
}

export function createApprovalChallenge(input: ApprovalChallengeInput): ApprovalChallenge {
  return challengeValue(input);
}

/** The host must inject this path; there is intentionally no implicit database. */
export function defaultApprovalGrantDbPath(): string {
  return join(homedir(), ".oracle", "approval-grants.sqlite");
}

function nullableText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return normalizeText(value, "identity");
}

function sameNullable(left: unknown, right: string | null | undefined): boolean {
  return (typeof left === "string" ? left : null) === (right ?? null);
}

function issueAuthorized(options: ApprovalGrantIssueOptions): boolean {
  return options.confirmed === true || options.localOperator === true;
}

/**
 * Host-owned authority for one-time approval grants. Browser and MCP services
 * receive challenges and may consume a grant; they must not call issueGrant.
 * The database stores only SHA-256(grant), never the opaque grant.
 */
export class ApprovalGrantAuthority {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly defaultTtlMs: number;
  private closed = false;

  constructor(options: ApprovalGrantAuthorityOptions) {
    if (!options?.dbPath)
      throw new ApprovalAuthorityError(
        "approval-authority-unavailable",
        "Approval authority requires an explicit SQLite path.",
      );
    const dbPath = options.dbPath;
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.now = options.now ?? (() => Date.now());
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(this.defaultTtlMs) || this.defaultTtlMs <= 0)
      throw new ApprovalAuthorityError(
        "approval-challenge-invalid",
        "Approval grant TTL must be a positive integer.",
      );
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approval_grants (
        grant_hash TEXT PRIMARY KEY NOT NULL,
        challenge_digest TEXT NOT NULL,
        operation TEXT NOT NULL,
        target TEXT NOT NULL,
        revision TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        expiry INTEGER NOT NULL,
        principal TEXT,
        session TEXT,
        issued_at INTEGER NOT NULL,
        consumed_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS approval_grants_expiry_idx ON approval_grants(expiry);
    `);
    const columns = this.db.prepare("PRAGMA table_info(approval_grants)").all() as Array<{
      name?: unknown;
    }>;
    if (!columns.some((column) => column.name === "consumed_at")) {
      try {
        this.db.exec("ALTER TABLE approval_grants ADD COLUMN consumed_at INTEGER");
      } catch (error) {
        const migrated = this.db.prepare("PRAGMA table_info(approval_grants)").all() as Array<{
          name?: unknown;
        }>;
        if (!migrated.some((column) => column.name === "consumed_at")) throw error;
      }
    }
  }

  /** Build a challenge using this authority's clock and configured TTL. */
  challenge(
    input: Omit<ApprovalChallengeInput, "expiry"> & { expiry?: number },
  ): ApprovalChallenge {
    return createApprovalChallenge({
      ...input,
      expiry: input.expiry ?? this.now() + this.defaultTtlMs,
    });
  }

  /** Issue only after host confirmation; this method never returns a grant on failure. */
  issueGrant(
    challenge: ApprovalChallenge,
    options: ApprovalGrantIssueOptions = {},
  ): ApprovalGrantIssueResult {
    if (this.closed) return { state: "requires_action", reason: "approval-authority-unavailable" };
    let normalized: ApprovalChallenge;
    try {
      normalized = challengeValue(challenge);
    } catch (error) {
      return {
        state: "requires_action",
        reason: error instanceof ApprovalAuthorityError ? error.code : "approval-challenge-invalid",
      };
    }
    if (normalized.expiry <= this.now())
      return { state: "requires_action", reason: "approval-challenge-expired" };
    if (!issueAuthorized(options))
      return { state: "requires_action", reason: "operator-confirmation-required" };
    const principal = nullableText(options.principal);
    const session = nullableText(options.session);
    const grant = randomBytes(GRANT_BYTES).toString("base64url");
    const grantHash = digest(grant);
    const challengeDigest = approvalChallengeDigest(normalized);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db
        .prepare(`INSERT INTO approval_grants (grant_hash, challenge_digest, operation, target, revision, payload_digest, expiry, principal, session, issued_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          grantHash,
          challengeDigest,
          normalized.operation,
          normalized.target,
          normalized.revision,
          normalized.payloadDigest,
          normalized.expiry,
          principal,
          session,
          this.now(),
        );
      this.db.exec("COMMIT");
      return { state: "issued", grant, challenge: normalized };
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* preserve fail-closed result */
      }
      return { state: "requires_action", reason: "approval-authority-unavailable" };
    }
  }

  /** Consume exactly once, atomically, before invoking a consequential driver. */
  consumeGrant(
    providedGrant: string | null | undefined,
    challenge: ApprovalChallenge,
    identity: ApprovalIdentity = {},
  ): ApprovalGrantConsumeResult {
    if (this.closed) return { state: "requires_action", reason: "approval-authority-unavailable" };
    if (typeof providedGrant !== "string" || !GRANT_FORMAT.test(providedGrant))
      return { state: "requires_action", reason: "approval-grant-unknown" };
    let normalized: ApprovalChallenge;
    try {
      normalized = challengeValue(challenge);
    } catch (error) {
      return {
        state: "requires_action",
        reason: error instanceof ApprovalAuthorityError ? error.code : "approval-challenge-invalid",
      };
    }
    const now = this.now();
    if (normalized.expiry <= now)
      return { state: "requires_action", reason: "approval-challenge-expired" };
    const grantHash = digest(providedGrant);
    const challengeDigest = approvalChallengeDigest(normalized);
    const principal = nullableText(identity.principal);
    const session = nullableText(identity.session);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const row = this.db
        .prepare(`SELECT challenge_digest, operation, target, revision, payload_digest, expiry, principal, session, consumed_at
        FROM approval_grants WHERE grant_hash = ?`)
        .get(grantHash) as Record<string, unknown> | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return { state: "requires_action", reason: "approval-grant-unknown" };
      }
      if (Number(row.expiry) <= now) {
        this.db.prepare("DELETE FROM approval_grants WHERE grant_hash = ?").run(grantHash);
        this.db.exec("COMMIT");
        return { state: "requires_action", reason: "approval-grant-expired" };
      }
      if (
        row.challenge_digest !== challengeDigest ||
        row.operation !== normalized.operation ||
        row.target !== normalized.target ||
        row.revision !== normalized.revision ||
        row.payload_digest !== normalized.payloadDigest
      ) {
        this.db.exec("COMMIT");
        return { state: "requires_action", reason: "approval-grant-mismatch" };
      }
      if (!sameNullable(row.principal, principal)) {
        this.db.exec("COMMIT");
        return { state: "requires_action", reason: "approval-principal-mismatch" };
      }
      if (!sameNullable(row.session, session)) {
        this.db.exec("COMMIT");
        return { state: "requires_action", reason: "approval-session-mismatch" };
      }
      if (row.consumed_at !== null && row.consumed_at !== undefined) {
        this.db.exec("COMMIT");
        return { state: "requires_action", reason: "approval-grant-replayed" };
      }
      const consumed = this.db
        .prepare(
          "UPDATE approval_grants SET consumed_at = ? WHERE grant_hash = ? AND consumed_at IS NULL AND expiry > ?",
        )
        .run(now, grantHash, now);
      if (Number(consumed.changes) !== 1) {
        this.db.exec("COMMIT");
        return { state: "requires_action", reason: "approval-grant-replayed" };
      }
      this.db.exec("COMMIT");
      return { state: "consumed", challenge: normalized };
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* preserve fail-closed result */
      }
      return { state: "requires_action", reason: "approval-authority-unavailable" };
    }
  }

  pruneExpired(): number {
    if (this.closed) return 0;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const result = this.db
        .prepare("DELETE FROM approval_grants WHERE expiry <= ?")
        .run(this.now());
      this.db.exec("COMMIT");
      return Number(result.changes);
    } catch {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore cleanup failure */
      }
      return 0;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

export const approvalGrantFormatForTest = GRANT_FORMAT;
export const approvalGrantDigestForTest = digest;
