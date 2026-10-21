import type { Migration } from "./types";

/**
 * Conversation-based derivation (architecture §2.6):
 * - mail_conversations: stage 0 assembly (thread + reply links) + fingerprint
 * - conversation_analysis: stage 1 triage output (AI, cached by fingerprint)
 * - mail_events: stage 3 per-mail process events (AI / regex / header / rule)
 * - sender_roles: per-account domain roles (intermediaries never key identity)
 * - tracker_items.events_json: time-independent event timeline (facts)
 * - settings: rejection_close_days / stale_close_days
 * Additive only.
 */
export const migration010Conversations: Migration = {
  version: 10,
  name: "conversations",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mail_conversations (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        thread_key TEXT,
        mail_ids TEXT NOT NULL DEFAULT '[]',
        fingerprint TEXT NOT NULL,
        item_id INTEGER,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mail_conversations_item_idx
        ON mail_conversations(item_id);

      CREATE TABLE IF NOT EXISTS conversation_analysis (
        conversation_id TEXT PRIMARY KEY,
        is_job_process INTEGER NOT NULL DEFAULT 1,
        employer TEXT,
        intermediary TEXT,
        intermediary_kind TEXT,
        position TEXT,
        ref_code TEXT,
        counterpart_email TEXT,
        model TEXT NOT NULL,
        prompt_version INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mail_events (
        mail_id INTEGER PRIMARY KEY REFERENCES mail_messages(id) ON DELETE CASCADE,
        conversation_id TEXT,
        event TEXT NOT NULL,
        waiting_until TEXT,
        confidence REAL,
        source TEXT NOT NULL,
        model TEXT,
        prompt_version INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mail_events_conversation_idx
        ON mail_events(conversation_id);

      CREATE TABLE IF NOT EXISTS sender_roles (
        account_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        role TEXT NOT NULL,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, domain)
      );
    `);

    const itemCols = new Set(
      (
        db.prepare(`PRAGMA table_info(tracker_items)`).all() as {
          name: string;
        }[]
      ).map((c) => c.name),
    );
    if (!itemCols.has("events_json")) {
      db.exec(`ALTER TABLE tracker_items ADD COLUMN events_json TEXT`);
    }

    const settingsCols = new Set(
      (
        db.prepare(`PRAGMA table_info(settings)`).all() as { name: string }[]
      ).map((c) => c.name),
    );
    if (!settingsCols.has("rejection_close_days")) {
      db.exec(
        `ALTER TABLE settings ADD COLUMN rejection_close_days INTEGER NOT NULL DEFAULT 10`,
      );
    }
    if (!settingsCols.has("stale_close_days")) {
      db.exec(
        `ALTER TABLE settings ADD COLUMN stale_close_days INTEGER NOT NULL DEFAULT 20`,
      );
    }
  },
};
