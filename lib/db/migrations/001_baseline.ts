import type { Migration } from "./types";

/**
 * Frozen port of the former ensureSchema() — CREATE IF NOT EXISTS + soft column
 * migrations for databases that predate schema_migrations.
 */
export const migration001Baseline: Migration = {
  version: 1,
  name: "baseline",
  up(db) {
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
        preferred_language TEXT NOT NULL DEFAULT 'en',
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
        derive_state TEXT NOT NULL DEFAULT 'done',
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
        research_job_id TEXT,
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

      CREATE TABLE IF NOT EXISTS tracker_timelines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL,
        company TEXT NOT NULL DEFAULT '',
        position TEXT,
        events_json TEXT NOT NULL DEFAULT '[]',
        origin TEXT NOT NULL DEFAULT 'unknown',
        model TEXT NOT NULL DEFAULT 'composer-2.5',
        locale TEXT NOT NULL DEFAULT 'en',
        mail_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS tracker_timelines_fp_uq
        ON tracker_timelines(fingerprint);
    `);

    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as {
      name: string;
    }[];
    if (!cols.some((c) => c.name === "preferred_language")) {
      db.exec(
        `ALTER TABLE settings ADD COLUMN preferred_language TEXT NOT NULL DEFAULT 'en'`,
      );
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
    if (
      itemColNames.has("search_job_id") &&
      !itemColNames.has("research_job_id")
    ) {
      try {
        db.exec(
          `ALTER TABLE tracker_items RENAME COLUMN search_job_id TO research_job_id`,
        );
        itemColNames.delete("search_job_id");
        itemColNames.add("research_job_id");
      } catch {
        /* ignore — will add column below if needed */
      }
    }
    const softCols: [string, string][] = [
      ["research_job_id", "TEXT"],
      ["has_follow_up_draft", "INTEGER NOT NULL DEFAULT 0"],
      ["has_thanks_draft", "INTEGER NOT NULL DEFAULT 0"],
      ["has_reply_draft", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, def] of softCols) {
      if (!itemColNames.has(name)) {
        db.exec(`ALTER TABLE tracker_items ADD COLUMN ${name} ${def}`);
      }
    }

    const syncCols = db.prepare(`PRAGMA table_info(sync_state)`).all() as {
      name: string;
    }[];
    if (!syncCols.some((c) => c.name === "window_days")) {
      db.exec(
        `ALTER TABLE sync_state ADD COLUMN window_days INTEGER NOT NULL DEFAULT 30`,
      );
    }

    const mailCols = db.prepare(`PRAGMA table_info(mail_messages)`).all() as {
      name: string;
    }[];
    if (!mailCols.some((c) => c.name === "derive_state")) {
      db.exec(
        `ALTER TABLE mail_messages ADD COLUMN derive_state TEXT NOT NULL DEFAULT 'done'`,
      );
    }
  },
};
