import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import path from "path";
import * as schema from "./schema";

const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "cmae.db");

let sqlite: Database.Database | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (dbInstance) return dbInstance;

  fs.mkdirSync(dataDir, { recursive: true });
  sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  dbInstance = drizzle(sqlite, { schema });
  ensureSchema(sqlite);
  return dbInstance;
}

/** Close the open SQLite handle (needed before deleting db files). */
export function closeDb() {
  if (sqlite) {
    try {
      sqlite.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      /* ignore */
    }
    try {
      sqlite.close();
    } catch {
      /* already closed */
    }
  }
  sqlite = null;
  dbInstance = null;
}

/**
 * Empty all app tables while the connection is open.
 * More reliable than file-delete when another handle may still exist.
 */
export function wipeDatabaseContents() {
  const db = getDb();
  // drizzle instance wraps better-sqlite3 — use the live handle
  if (!sqlite) throw new Error("SQLite handle missing");
  sqlite.exec(`
    PRAGMA foreign_keys = OFF;
    DELETE FROM tracker_item_mails;
    DELETE FROM tracker_items;
    DELETE FROM mail_messages;
    DELETE FROM mail_folder_cursors;
    DELETE FROM sync_state;
    DELETE FROM settings;
    PRAGMA foreign_keys = ON;
    INSERT INTO sync_state (id, window_days) VALUES (1, 30);
    INSERT INTO settings (id, follow_up_days, preferred_language)
      VALUES (1, 5, 'tr');
  `);
  // Touch drizzle so callers keep using the same wrapper
  void db;
}

/** Delete local SQLite files so the next getDb() is a cold empty schema. */
export function wipeDatabaseFiles() {
  closeDb();
  const errors: string[] = [];
  for (const name of ["cmae.db", "cmae.db-wal", "cmae.db-shm"] as const) {
    const p = path.join(dataDir, name);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (err) {
      errors.push(
        `${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (errors.length && fs.existsSync(dbPath)) {
    // File still there — contents wipe already ran; reopen and ensure empty
    getDb();
    wipeDatabaseContents();
  }
}

function ensureSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      full_name TEXT,
      gmail_address TEXT,
      gmail_app_password_enc TEXT,
      cursor_api_key_enc TEXT,
      cv_text TEXT,
      cv_file_name TEXT,
      follow_up_days INTEGER NOT NULL DEFAULT 5,
      preferred_language TEXT NOT NULL DEFAULT 'tr',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT OR IGNORE INTO settings (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS mail_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      thread_id TEXT,
      gmail_uid INTEGER,
      folder TEXT NOT NULL,
      from_addr TEXT NOT NULL,
      to_addr TEXT NOT NULL DEFAULT '',
      cc_addr TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      date_iso TEXT NOT NULL,
      snippet TEXT NOT NULL DEFAULT '',
      body_text TEXT NOT NULL DEFAULT '',
      headers_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS mail_messages_message_id_uq ON mail_messages(message_id);

    CREATE TABLE IF NOT EXISTS tracker_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      position TEXT,
      status TEXT NOT NULL DEFAULT 'ready_to_send',
      sentiment TEXT,
      waiting_on TEXT,
      follow_up_count INTEGER NOT NULL DEFAULT 0,
      last_outbound_at TEXT,
      last_inbound_at TEXT,
      next_follow_up_at TEXT,
      ignored INTEGER NOT NULL DEFAULT 0,
      workspace_folder TEXT,
      search_job_id TEXT,
      primary_to TEXT,
      notes_json TEXT,
      has_follow_up_draft INTEGER NOT NULL DEFAULT 0,
      has_thanks_draft INTEGER NOT NULL DEFAULT 0,
      has_reply_draft INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tracker_item_mails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES tracker_items(id) ON DELETE CASCADE,
      mail_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'inbound'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tracker_item_mails_uq ON tracker_item_mails(item_id, mail_id);

    CREATE TABLE IF NOT EXISTS sync_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      last_sync_at TEXT,
      last_error TEXT,
      window_days INTEGER NOT NULL DEFAULT 30
    );
    INSERT OR IGNORE INTO sync_state (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS mail_folder_cursors (
      folder TEXT PRIMARY KEY,
      mailbox_path TEXT NOT NULL,
      uid_validity TEXT NOT NULL,
      last_uid INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // soft migrate
  const cols = db.prepare(`PRAGMA table_info(settings)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "preferred_language")) {
    db.exec(`ALTER TABLE settings ADD COLUMN preferred_language TEXT NOT NULL DEFAULT 'tr'`);
  }
  if (!cols.some((c) => c.name === "email_signature")) {
    db.exec(`ALTER TABLE settings ADD COLUMN email_signature TEXT`);
  }
  if (!cols.some((c) => c.name === "job_preferences_json")) {
    db.exec(`ALTER TABLE settings ADD COLUMN job_preferences_json TEXT`);
  }
  if (!cols.some((c) => c.name === "onboarding_completed_at")) {
    db.exec(`ALTER TABLE settings ADD COLUMN onboarding_completed_at TEXT`);
  }
  // Drop legacy profile fields (kept only in email signature now)
  for (const dropCol of ["email", "phone", "linkedin_url"] as const) {
    if (cols.some((c) => c.name === dropCol)) {
      try {
        db.exec(`ALTER TABLE settings DROP COLUMN ${dropCol}`);
      } catch {
        /* older SQLite / busy — ignore; columns unused */
      }
    }
  }

  const itemCols = db.prepare(`PRAGMA table_info(tracker_items)`).all() as {
    name: string;
  }[];
  const itemColNames = new Set(itemCols.map((c) => c.name));
  const softCols: [string, string][] = [
    ["has_follow_up_draft", "INTEGER NOT NULL DEFAULT 0"],
    ["has_thanks_draft", "INTEGER NOT NULL DEFAULT 0"],
    ["has_reply_draft", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, def] of softCols) {
    if (!itemColNames.has(name)) {
      db.exec(`ALTER TABLE tracker_items ADD COLUMN ${name} ${def}`);
    }
  }

  // Older DBs had sync_state(last_uid) without window_days
  const syncCols = db.prepare(`PRAGMA table_info(sync_state)`).all() as {
    name: string;
  }[];
  if (!syncCols.some((c) => c.name === "window_days")) {
    db.exec(
      `ALTER TABLE sync_state ADD COLUMN window_days INTEGER NOT NULL DEFAULT 30`,
    );
  }
}

export type Db = ReturnType<typeof getDb>;
