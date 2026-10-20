import type Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { MIGRATIONS } from "./migrations";

function ensureMigrationsTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

function appliedVersions(db: Database.Database): Set<number> {
  const rows = db
    .prepare(`SELECT version FROM schema_migrations`)
    .all() as { version: number }[];
  return new Set(rows.map((r) => r.version));
}

function backupDb(db: Database.Database, dbPath: string, version: number) {
  const dir = path.dirname(dbPath);
  const dest = path.join(dir, `cmae.db.pre-v${version}`);
  try {
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
  } catch {
    /* ignore */
  }
  try {
    db.backup(dest);
  } catch (err) {
    console.error("[migrate] sqlite.backup failed", err);
  }
}

function applyOne(db: Database.Database, version: number, up: () => void) {
  db.transaction(() => {
    up();
    db.prepare(
      `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
    ).run(version, new Date().toISOString());
  })();
}

/**
 * Apply pending migrations. Safe to call on every getDb() open.
 * Backs up with sqlite.backup() before additive migrations on an existing DB.
 */
export function runMigrations(db: Database.Database, dbPath: string) {
  ensureMigrationsTable(db);
  const applied = appliedVersions(db);
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version)).sort(
    (a, b) => a.version - b.version,
  );
  if (!pending.length) return;

  const hasExistingData =
    applied.size > 0 ||
    (
      db.prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='tracker_items'`,
      ).get() as { ok: number } | undefined
    )?.ok === 1;

  for (const m of pending) {
    // Backup before each migration when the DB already has app tables / prior migrations.
    if (hasExistingData || applied.size > 0 || m.version > 1) {
      backupDb(db, dbPath, m.version);
    }
    applyOne(db, m.version, () => m.up(db));
    applied.add(m.version);
  }
}
