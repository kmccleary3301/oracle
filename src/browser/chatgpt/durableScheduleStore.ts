import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type {
  ChatgptScheduleRecord,
  ChatgptScheduleState,
  ChatgptScheduleStore,
} from "./scheduleTypes.js";

export interface DurableChatgptScheduleStoreOptions {
  databasePath: string;
  busyTimeoutMs?: number;
  now?: () => number;
}

export interface ScheduleStoreSnapshot {
  scheduleId: string;
  revisionHash: string;
  desiredState?: Exclude<ChatgptScheduleState, "unknown">;
  record: ChatgptScheduleRecord;
  updatedAt: number;
}

const SCHEMA_VERSION = 1;

function cloneRecord(record: ChatgptScheduleRecord): ChatgptScheduleRecord {
  return JSON.parse(JSON.stringify(record)) as ChatgptScheduleRecord;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function desiredState(value: unknown): Exclude<ChatgptScheduleState, "unknown"> | undefined {
  return value === "active" || value === "paused" || value === "completed" || value === "deleted"
    ? value
    : undefined;
}

/**
 * Restart-safe desired-state storage. Rows are metadata only; browser observations remain
 * in the record JSON and every conditional write can be guarded by its observed revision.
 */
export class DurableChatgptScheduleStore implements ChatgptScheduleStore {
  static readonly #locks = new Map<string, Promise<void>>();
  readonly databasePath: string;
  readonly #db: DatabaseSync;
  readonly #clock: () => number;
  readonly #lockKey: string;
  #transactionDepth = 0;
  #closed = false;
  constructor(options: DurableChatgptScheduleStoreOptions | string) {
    const input = typeof options === "string" ? { databasePath: options } : options;
    const requestedPath = requiredText(input.databasePath, "databasePath");
    this.databasePath = requestedPath === ":memory:" ? requestedPath : path.resolve(requestedPath);
    this.#lockKey = this.databasePath;
    this.#clock = input.now ?? Date.now;
    if (this.databasePath !== ":memory:")
      mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(this.databasePath, { enableForeignKeyConstraints: true });
    const busyTimeoutMs =
      Number.isInteger(input.busyTimeoutMs) && (input.busyTimeoutMs ?? 0) >= 0
        ? (input.busyTimeoutMs as number)
        : 5_000;
    this.#db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS chatgpt_schedule_store_meta (
        schema_version INTEGER PRIMARY KEY,
        initialized_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chatgpt_schedule_desired_state (
        schedule_id TEXT PRIMARY KEY,
        revision_hash TEXT NOT NULL,
        desired_state TEXT,
        terminal INTEGER NOT NULL DEFAULT 0,
        record_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO chatgpt_schedule_store_meta (schema_version, initialized_at) VALUES (?, ?)",
      )
      .run(SCHEMA_VERSION, this.#clock());
  }

  load(): ChatgptScheduleRecord[] {
    this.#assertOpen();
    const rows = this.#db
      .prepare("SELECT record_json FROM chatgpt_schedule_desired_state ORDER BY schedule_id")
      .all() as Array<{ record_json: string }>;
    return rows.flatMap((row) => {
      try {
        const record = JSON.parse(row.record_json) as ChatgptScheduleRecord;
        return record && typeof record === "object" ? [cloneRecord(record)] : [];
      } catch {
        return [];
      }
    });
  }

  get(scheduleId: string): ChatgptScheduleRecord | undefined {
    this.#assertOpen();
    const id = requiredText(scheduleId, "scheduleId");
    const row = this.#db
      .prepare("SELECT record_json FROM chatgpt_schedule_desired_state WHERE schedule_id = ?")
      .get(id) as { record_json?: string } | undefined;
    if (!row?.record_json) return undefined;
    try {
      return cloneRecord(JSON.parse(row.record_json) as ChatgptScheduleRecord);
    } catch {
      return undefined;
    }
  }

  snapshot(scheduleId: string): ScheduleStoreSnapshot | undefined {
    this.#assertOpen();
    const id = requiredText(scheduleId, "scheduleId");
    const row = this.#db
      .prepare(
        "SELECT revision_hash, desired_state, record_json, updated_at FROM chatgpt_schedule_desired_state WHERE schedule_id = ?",
      )
      .get(id) as
      | {
          revision_hash?: string;
          desired_state?: string | null;
          record_json?: string;
          updated_at?: number;
        }
      | undefined;
    if (!row?.record_json || typeof row.revision_hash !== "string") return undefined;
    try {
      const record = cloneRecord(JSON.parse(row.record_json) as ChatgptScheduleRecord);
      return {
        scheduleId: id,
        revisionHash: row.revision_hash,
        ...(desiredState(row.desired_state)
          ? { desiredState: desiredState(row.desired_state) }
          : {}),
        record,
        updatedAt: Number(row.updated_at ?? 0),
      };
    } catch {
      return undefined;
    }
  }

  save(record: ChatgptScheduleRecord): void {
    this.#assertOpen();
    const next = cloneRecord(record);
    const id = requiredText(next.scheduleId, "scheduleId");
    const revision = requiredText(next.revisionHash, "revisionHash");
    const desired =
      desiredState(next.desiredState) ?? (next.state === "unknown" ? undefined : next.state);
    const terminal = desired === "completed" || desired === "deleted" ? 1 : 0;
    this.#transaction(() => {
      this.#db
        .prepare(`
        INSERT INTO chatgpt_schedule_desired_state (schedule_id, revision_hash, desired_state, terminal, record_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(schedule_id) DO UPDATE SET revision_hash = excluded.revision_hash, desired_state = excluded.desired_state,
          terminal = excluded.terminal, record_json = excluded.record_json, updated_at = excluded.updated_at
      `)
        .run(
          id,
          revision,
          desired ?? null,
          terminal,
          JSON.stringify({ ...next, ...(desired ? { desiredState: desired } : {}) }),
          this.#clock(),
        );
    });
  }

  remove(scheduleId: string): void {
    this.#assertOpen();
    const id = requiredText(scheduleId, "scheduleId");
    this.#transaction(() => {
      this.#db.prepare("DELETE FROM chatgpt_schedule_desired_state WHERE schedule_id = ?").run(id);
    });
  }
  /** Atomically persists a new observation only when the expected revision still owns the row. */
  compareAndSwap(
    scheduleId: string,
    expectedRevisionHash: string | null,
    next: ChatgptScheduleRecord,
  ): boolean {
    this.#assertOpen();
    const id = requiredText(scheduleId, "scheduleId");
    const expected =
      expectedRevisionHash === null
        ? null
        : requiredText(expectedRevisionHash, "expectedRevisionHash");
    const record = cloneRecord(next);
    if (record.scheduleId !== id) return false;
    const revision = requiredText(record.revisionHash, "revisionHash");
    const desired =
      desiredState(record.desiredState) ?? (record.state === "unknown" ? undefined : record.state);
    const terminal = desired === "completed" || desired === "deleted" ? 1 : 0;
    return this.#transaction(() => {
      const row = this.#db
        .prepare("SELECT revision_hash FROM chatgpt_schedule_desired_state WHERE schedule_id = ?")
        .get(id) as { revision_hash?: string } | undefined;
      if (expected === null ? row !== undefined : row?.revision_hash !== expected) return false;
      if (row) {
        this.#db
          .prepare(
            `UPDATE chatgpt_schedule_desired_state SET revision_hash = ?, desired_state = ?, terminal = ?, record_json = ?, updated_at = ? WHERE schedule_id = ? AND revision_hash = ?`,
          )
          .run(
            revision,
            desired ?? null,
            terminal,
            JSON.stringify({ ...record, ...(desired ? { desiredState: desired } : {}) }),
            this.#clock(),
            id,
            expected,
          );
      } else {
        this.#db
          .prepare(
            `INSERT INTO chatgpt_schedule_desired_state (schedule_id, revision_hash, desired_state, terminal, record_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            revision,
            desired ?? null,
            terminal,
            JSON.stringify({ ...record, ...(desired ? { desiredState: desired } : {}) }),
            this.#clock(),
          );
      }
      return true;
    });
  }

  saveIfRevision(record: ChatgptScheduleRecord, expectedRevisionHash: string | null): boolean {
    return this.compareAndSwap(record.scheduleId, expectedRevisionHash, record);
  }

  replaceIfRevision = this.saveIfRevision.bind(this);

  setDesiredState(
    scheduleId: string,
    desired: Exclude<ChatgptScheduleState, "unknown">,
    expectedRevisionHash: string,
  ): boolean {
    this.#assertOpen();
    const id = requiredText(scheduleId, "scheduleId");
    const expected = requiredText(expectedRevisionHash, "expectedRevisionHash");
    return this.#transaction(() => {
      const row = this.#db
        .prepare(
          "SELECT record_json FROM chatgpt_schedule_desired_state WHERE schedule_id = ? AND revision_hash = ?",
        )
        .get(id, expected) as { record_json?: string } | undefined;
      if (!row?.record_json) return false;
      let record: ChatgptScheduleRecord;
      try {
        record = JSON.parse(row.record_json) as ChatgptScheduleRecord;
      } catch {
        return false;
      }
      const next = { ...record, desiredState: desired };
      this.#db
        .prepare(
          "UPDATE chatgpt_schedule_desired_state SET desired_state = ?, terminal = ?, record_json = ?, updated_at = ? WHERE schedule_id = ? AND revision_hash = ?",
        )
        .run(
          desired,
          desired === "completed" || desired === "deleted" ? 1 : 0,
          JSON.stringify(next),
          this.#clock(),
          id,
          expected,
        );
      return true;
    });
  }

  markTerminal(
    scheduleId: string,
    state: "completed" | "deleted",
    expectedRevisionHash: string,
  ): boolean {
    return this.setDesiredState(scheduleId, state, expectedRevisionHash);
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    if (this.#transactionDepth > 0) return fn();
    const prior = DurableChatgptScheduleStore.#locks.get(this.#lockKey);
    let releaseGate!: () => void;
    const gatePromise = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    DurableChatgptScheduleStore.#locks.set(this.#lockKey, gatePromise);
    if (prior) await prior;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      this.#transactionDepth += 1;
      try {
        const result = await fn();
        this.#db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          /* preserve callback failure */
        }
        throw error;
      } finally {
        this.#transactionDepth -= 1;
      }
    } finally {
      releaseGate();
      if (DurableChatgptScheduleStore.#locks.get(this.#lockKey) === gatePromise)
        DurableChatgptScheduleStore.#locks.delete(this.#lockKey);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #transaction<T>(fn: () => T): T {
    this.#assertOpen();
    if (this.#transactionDepth > 0) return fn();
    this.#db.exec("BEGIN IMMEDIATE");
    this.#transactionDepth += 1;
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        /* preserve callback failure */
      }
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("schedule store is closed");
  }
}

export class SQLiteChatgptScheduleStore extends DurableChatgptScheduleStore {}
export class SqliteChatgptScheduleStore extends DurableChatgptScheduleStore {}
export function openDurableChatgptScheduleStore(
  options: DurableChatgptScheduleStoreOptions | string,
): DurableChatgptScheduleStore {
  return new DurableChatgptScheduleStore(options);
}
