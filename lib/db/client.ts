import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import path from "path";
import { getDataDir } from "@/lib/paths";
import { runMigrations } from "./migrate";
import * as schema from "./schema";

let sqlite: Database.Database | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;
/** Path we opened — if getAppRoot flips (sticky/env), reopen the right file. */
let openedDbPath: string | null = null;

function dbPaths() {
  const dataDir = getDataDir();
  return { dataDir, dbPath: path.join(dataDir, "cmae.db") };
}

export function getDb() {
  const { dbPath } = dbPaths();
  if (dbInstance && openedDbPath === dbPath && sqlite?.open) {
    return dbInstance;
  }
  // Path flip or closed handle — drop stale drizzle wrapper before reopen.
  // Callers must not cache the returned drizzle instance across awaits; a
  // concurrent closeDb()/wipe can invalidate it while IMAP sync is in flight.
  if (dbInstance || sqlite) closeDb();

  sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");

  dbInstance = drizzle(sqlite, { schema });
  openedDbPath = dbPath;
  runMigrations(sqlite, dbPath);
  return dbInstance;
}

/** Live better-sqlite3 handle (same connection as getDb). For sync transactions. */
export function getSqlite(): Database.Database {
  getDb();
  if (!sqlite?.open) {
    // Rare race: closed between getDb reopen and read — try once more.
    closeDb();
    getDb();
  }
  if (!sqlite?.open) throw new Error("SQLite handle missing");
  return sqlite;
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
  openedDbPath = null;
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
    DELETE FROM tracker_timelines;
    DELETE FROM tracker_items;
    DELETE FROM mail_messages;
    DELETE FROM mail_folder_cursors;
    DELETE FROM sync_state;
    DELETE FROM settings;
    DELETE FROM tracker_changes;
    DELETE FROM app_meta;
    PRAGMA foreign_keys = ON;
    INSERT INTO sync_state (id, window_days) VALUES (1, 30);
    INSERT INTO settings (id, follow_up_days, preferred_language)
      VALUES (1, 5, 'en');
    INSERT INTO app_meta (key, value) VALUES ('tracker_revision', '0');
    INSERT INTO app_meta (key, value) VALUES ('db_epoch', '0');
    INSERT INTO app_meta (key, value) VALUES ('credentials_version', '0');
    INSERT INTO app_meta (key, value) VALUES ('account_id', '');
    INSERT INTO app_meta (key, value) VALUES ('maintenance_until', '');
  `);
  for (const table of [
    "sync_jobs",
    "mail_assignments",
    "mail_unassigned",
    "mail_intents",
    "merge_proposals",
    "item_lineage",
    "item_ops",
    "mail_sources",
    "mail_fetch_failures",
    "gmail_drafts",
    "workspace_files",
    "workspace_folders",
  ]) {
    try {
      sqlite.exec(`DELETE FROM ${table}`);
    } catch {
      /* table may not exist mid-upgrade */
    }
  }
  try {
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    /* ignore */
  }
  // Touch drizzle so callers keep using the same wrapper
  void db;
}

/** Delete local SQLite files so the next getDb() is a cold empty schema. */
export function wipeDatabaseFiles() {
  closeDb();
  const { dataDir, dbPath } = dbPaths();
  const errors: string[] = [];
  for (const name of ["cmae.db", "cmae.db-wal", "cmae.db-shm"] as const) {
    const p = path.join(/*turbopackIgnore: true*/ dataDir, name);
    try {
      if (fs.existsSync(/*turbopackIgnore: true*/ p)) fs.unlinkSync(p);
    } catch (err) {
      errors.push(
        `${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (errors.length && fs.existsSync(/*turbopackIgnore: true*/ dbPath)) {
    // File still there — contents wipe already ran; reopen and ensure empty
    getDb();
    wipeDatabaseContents();
  }
}

export type Db = ReturnType<typeof getDb>;
