import type { DatabaseSync } from "node:sqlite";
import { COORDINATOR_SCHEMA_VERSION } from "./coordinatorTypes.js";

export const COORDINATOR_REQUIRED_TABLES = [
  "schema_meta",
  "profiles",
  "targets",
  "jobs",
  "job_events",
  "attachments",
  "artifacts",
  "rate_limits",
  "resource_samples",
  "resource_gate",
] as const;

export function coordinatorSchemaV2Sql(nowMs: number): string {
  return `
          CREATE TABLE schema_meta (
            version INTEGER PRIMARY KEY,
            initialized_at INTEGER NOT NULL
          );
          CREATE TABLE profiles (
            profile_id TEXT PRIMARY KEY,
            path TEXT,
            generation INTEGER NOT NULL CHECK (generation > 0),
            owner_pid INTEGER,
            owner_start_token TEXT,
            browser_pid INTEGER,
            devtools_endpoint TEXT,
            state TEXT NOT NULL CHECK (state IN ('running', 'stopped')),
            heartbeat_at INTEGER
          );
          CREATE TABLE targets (
            target_id TEXT PRIMARY KEY,
            reservation_id TEXT NOT NULL UNIQUE,
            profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
            generation INTEGER NOT NULL CHECK (generation > 0),
            role TEXT NOT NULL,
            owner_job_id TEXT,
            state TEXT NOT NULL CHECK (state IN ('admitted', 'active', 'closing', 'closed', 'lost')),
            url TEXT,
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL
          );
          CREATE INDEX targets_profile_active_idx
            ON targets(profile_id, generation, state, role);
          CREATE TABLE jobs (
            job_id TEXT PRIMARY KEY,
            profile_id TEXT REFERENCES profiles(profile_id) ON DELETE SET NULL,
            operation TEXT NOT NULL,
            state TEXT NOT NULL,
            reason_code TEXT,
            request_hash TEXT,
            conversation_id TEXT,
            expected_head TEXT,
            owner_generation INTEGER,
            owner_lease_id TEXT,
            idempotency_key TEXT,
            attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            retry_policy TEXT
          );
          CREATE INDEX jobs_profile_state_idx ON jobs(profile_id, state, updated_at);
          CREATE UNIQUE INDEX jobs_profile_idempotency_idx
            ON jobs(profile_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
          CREATE TABLE job_events (
            job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL CHECK (sequence > 0),
            state TEXT NOT NULL,
            reason_code TEXT,
            evidence_path TEXT,
            timestamp INTEGER NOT NULL,
            PRIMARY KEY (job_id, sequence)
          );
          CREATE TABLE attachments (
            attachment_id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
            path TEXT NOT NULL,
            size INTEGER NOT NULL CHECK (size >= 0),
            media_type TEXT,
            sha256 TEXT,
            remote_file_id TEXT,
            observed_state TEXT
          );
          CREATE TABLE artifacts (
            artifact_id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            source_url TEXT,
            path TEXT,
            size INTEGER CHECK (size IS NULL OR size >= 0),
            sha256 TEXT,
            turn_id TEXT
          );
          CREATE TABLE rate_limits (
            profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            limit_value REAL,
            remaining REAL,
            reset_at INTEGER,
            retry_after REAL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (profile_id, key)
          );
          CREATE TABLE resource_samples (
            sample_id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
            generation INTEGER,
            sampled_at INTEGER NOT NULL,
            process_tree_rss_bytes INTEGER NOT NULL CHECK (process_tree_rss_bytes >= 0),
            process_tree_cpu_time_ms REAL,
            chrome_pid INTEGER,
            process_count INTEGER
          );
          CREATE INDEX resource_samples_profile_idx
            ON resource_samples(profile_id, sampled_at DESC, sample_id DESC);
          CREATE TABLE resource_gate (
            profile_id TEXT PRIMARY KEY REFERENCES profiles(profile_id) ON DELETE CASCADE,
            generation INTEGER,
            phase TEXT NOT NULL CHECK (phase IN ('normal', 'soft', 'hard', 'unknown')),
            reason TEXT NOT NULL,
            process_tree_rss_bytes INTEGER,
            rss_soft_bytes INTEGER NOT NULL CHECK (rss_soft_bytes > 0),
            rss_hard_bytes INTEGER NOT NULL CHECK (rss_hard_bytes > 0),
            rss_resume_bytes INTEGER NOT NULL CHECK (rss_resume_bytes > 0),
            sampled_at INTEGER NOT NULL
          );
          INSERT INTO schema_meta(version, initialized_at) VALUES (2, ${Math.trunc(nowMs)});
          PRAGMA user_version = 2;
        `;
}

export function coordinatorSchemaV1ToV2Sql(): string {
  return `
          CREATE TABLE resource_gate (
            profile_id TEXT PRIMARY KEY REFERENCES profiles(profile_id) ON DELETE CASCADE,
            generation INTEGER,
            phase TEXT NOT NULL CHECK (phase IN ('normal', 'soft', 'hard', 'unknown')),
            reason TEXT NOT NULL,
            process_tree_rss_bytes INTEGER,
            rss_soft_bytes INTEGER NOT NULL CHECK (rss_soft_bytes > 0),
            rss_hard_bytes INTEGER NOT NULL CHECK (rss_hard_bytes > 0),
            rss_resume_bytes INTEGER NOT NULL CHECK (rss_resume_bytes > 0),
            sampled_at INTEGER NOT NULL
          );
          UPDATE schema_meta SET version = 2;
          PRAGMA user_version = 2;
        `;
}

export function validateCoordinatorSchema(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String((row as { name: unknown }).name));
  for (const name of COORDINATOR_REQUIRED_TABLES) {
    if (!rows.includes(name)) throw new Error(`Coordinator database is missing table ${name}.`);
  }
  const schemaVersion = Number(
    (db.prepare("SELECT MAX(version) AS version FROM schema_meta").get() as { version?: unknown })
      ?.version ?? 0,
  );
  if (schemaVersion !== COORDINATOR_SCHEMA_VERSION) {
    throw new Error(`Coordinator database metadata version ${schemaVersion} is unsupported.`);
  }
}

export function initializeCoordinatorSchema(
  db: DatabaseSync,
  nowMs: number,
  transaction: (callback: () => void) => void,
): void {
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version?: unknown })?.user_version ?? 0,
  );
  if (version > COORDINATOR_SCHEMA_VERSION) {
    throw new Error(
      `Coordinator database schema ${version} is newer than supported version ${COORDINATOR_SCHEMA_VERSION}.`,
    );
  }
  if (version === 0) {
    const existingTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String((row as { name: unknown }).name));
    if (existingTables.length > 0) {
      throw new Error("Coordinator database has an incomplete or unsupported schema.");
    }
    transaction(() => {
      db.exec(coordinatorSchemaV2Sql(nowMs));
    });
    return;
  }
  if (version === 1) {
    transaction(() => {
      db.exec(coordinatorSchemaV1ToV2Sql());
    });
  }
  validateCoordinatorSchema(db);
}
