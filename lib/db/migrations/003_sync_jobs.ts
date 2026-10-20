import type { Migration } from "./types";

/** Persistent sync jobs, lease index, fencing meta keys. */
export const migration003SyncJobs: Migration = {
  version: 3,
  name: "sync_jobs",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'incremental',
        state TEXT NOT NULL,
        phase TEXT,
        reasons TEXT NOT NULL DEFAULT '[]',
        rerun_requested INTEGER NOT NULL DEFAULT 0,
        rerun_mode TEXT,
        attempt INTEGER NOT NULL DEFAULT 1,
        owner TEXT,
        db_epoch INTEGER NOT NULL,
        credentials_version INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        error_kind TEXT,
        error_message TEXT,
        stats_json TEXT,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        heartbeat_at TEXT,
        progress_at TEXT,
        finished_at TEXT,
        next_retry_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS sync_jobs_one_running
        ON sync_jobs(kind) WHERE state = 'running';

      CREATE INDEX IF NOT EXISTS sync_jobs_kind_state
        ON sync_jobs(kind, state, queued_at);
    `);

    db.prepare(
      `INSERT OR IGNORE INTO app_meta (key, value) VALUES ('db_epoch', '0')`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO app_meta (key, value) VALUES ('credentials_version', '0')`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO app_meta (key, value) VALUES ('account_id', '')`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO app_meta (key, value) VALUES ('maintenance_until', '')`,
    ).run();
  },
};
