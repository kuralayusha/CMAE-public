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
/**
 * Inode of the file we opened. Wipe / sibling rm can replace `cmae.db` under an
 * open handle (ghost inode); path string stays equal but directory entry is a
 * new empty file — writes then vanish from status/CLI readers.
 */
let openedDbIno: number | null = null;
let openedDbDev: number | null = null;

function dbPaths() {
  const dataDir = getDataDir();
  return { dataDir, dbPath: path.join(dataDir, "cmae.db") };
}

function pathIdentity(
  dbPath: string,
): { ino: number; dev: number } | null {
  try {
    const st = fs.statSync(/*turbopackIgnore: true*/ dbPath);
    return { ino: st.ino, dev: st.dev };
  } catch {
    return null;
  }
}

export function getDb() {
  const { dbPath } = dbPaths();
  const onDisk = pathIdentity(dbPath);
  const handleLive =
    Boolean(dbInstance && openedDbPath === dbPath && sqlite?.open);
  const sameInode =
    handleLive &&
    onDisk != null &&
    openedDbIno != null &&
    openedDbDev != null &&
    onDisk.ino === openedDbIno &&
    onDisk.dev === openedDbDev;
  if (handleLive && sameInode) {
    return dbInstance!;
  }
  // Path flip, closed handle, or file replaced under us (ghost inode) —
  // drop stale drizzle wrapper before reopen.
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
  const opened = pathIdentity(dbPath);
  openedDbIno = opened?.ino ?? null;
  openedDbDev = opened?.dev ?? null;
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
  openedDbIno = null;
  openedDbDev = null;
}

/**
 * Empty all app tables while the connection is open.
 * More reliable than file-delete when another handle may still exist.
 *
 * `dbEpoch` / `credentialsVersion` must stay elevated after a fenced reset
 * (architecture §2.5.2 / edge-case #33). Resetting them to 0 lets a pre-wipe
 * writer whose job also held epoch 0 pass fencing and repopulate the DB.
 */
export function wipeDatabaseContents(opts?: {
  dbEpoch?: number;
  credentialsVersion?: number;
}) {
  const db = getDb();
  // drizzle instance wraps better-sqlite3 — use the live handle
  if (!sqlite) throw new Error("SQLite handle missing");
  const dbEpoch = Math.max(1, opts?.dbEpoch ?? 1);
  const credentialsVersion = Math.max(0, opts?.credentialsVersion ?? 0);
  // Consent + anonymous-id backup must survive a wipe (opt-out stays opted out;
  // the userData/anon-id file is never touched here).
  let telemetryEnabled = 1;
  let anonBackup = "";
  try {
    const row = sqlite
      .prepare(`SELECT usage_telemetry_enabled AS v FROM settings WHERE id = 1`)
      .get() as { v: number } | undefined;
    if (row && row.v === 0) telemetryEnabled = 0;
    const b = sqlite
      .prepare(`SELECT value FROM app_meta WHERE key = 'anon_id_backup'`)
      .get() as { value: string } | undefined;
    anonBackup = b?.value ?? "";
  } catch {
    /* columns/tables may not exist mid-upgrade */
  }
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
    INSERT INTO settings (id, follow_up_days, preferred_language, usage_telemetry_enabled)
      VALUES (1, 5, 'en', ${telemetryEnabled});
    INSERT INTO app_meta (key, value) VALUES ('tracker_revision', '0');
    INSERT INTO app_meta (key, value) VALUES ('db_epoch', '${dbEpoch}');
    INSERT INTO app_meta (key, value) VALUES ('credentials_version', '${credentialsVersion}');
    INSERT INTO app_meta (key, value) VALUES ('account_id', '');
    INSERT INTO app_meta (key, value) VALUES ('maintenance_until', '');
  `);
  if (anonBackup) {
    sqlite
      .prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES ('anon_id_backup', ?)`)
      .run(anonBackup);
  }
  for (const table of [
    "sync_jobs",
    "mail_assignments",
    "mail_unassigned",
    "mail_intents",
    "mail_events",
    "mail_conversations",
    "conversation_analysis",
    "sender_roles",
    "merge_proposals",
    "item_lineage",
    "item_ops",
    "mail_sources",
    "mail_fetch_failures",
    "gmail_drafts",
    "workspace_files",
    "workspace_folders",
    // mail-derived cached model output; usage events intentionally stay
    "ai_response_cache",
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
