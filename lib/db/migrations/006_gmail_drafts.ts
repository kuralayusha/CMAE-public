import { randomUUID } from "crypto";
import type { Migration } from "./types";

type PendingShape = {
  kind?: string;
  at?: string;
  subject?: string;
  draftsUrl?: string;
};

const PENDING_KINDS = new Set([
  "application",
  "follow_up",
  "thanks",
  "reply",
]);

/**
 * Faz 5: gmail_drafts table + legacy notesJson.pendingGmailDraft migration.
 * Additive only — notesJson key cleared after row insert so list reads one source.
 */
export const migration006GmailDrafts: Migration = {
  version: 6,
  name: "gmail_drafts",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gmail_drafts (
        id TEXT PRIMARY KEY,
        item_id INTEGER NOT NULL REFERENCES tracker_items(id),
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        message_id_hdr TEXT NOT NULL,
        gm_msgid TEXT,
        gm_thrid TEXT,
        drafts_uid INTEGER,
        drafts_uidvalidity TEXT,
        subject TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        confirmed_at TEXT,
        last_seen_at TEXT,
        last_checked_at TEXT,
        missing_since TEXT,
        missing_checks INTEGER NOT NULL DEFAULT 0,
        sent_mail_id INTEGER REFERENCES mail_messages(id),
        error TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS gmail_drafts_live_uq
        ON gmail_drafts(item_id, kind)
        WHERE state IN ('creating', 'present', 'unknown');

      CREATE INDEX IF NOT EXISTS gmail_drafts_item_idx
        ON gmail_drafts(item_id);

      CREATE INDEX IF NOT EXISTS gmail_drafts_account_state_idx
        ON gmail_drafts(account_id, state);
    `);

    const accountRow = db
      .prepare(`SELECT value FROM app_meta WHERE key = 'account_id'`)
      .get() as { value: string } | undefined;
    const settingsAddr = db
      .prepare(`SELECT gmail_address AS addr FROM settings WHERE id = 1`)
      .get() as { addr: string | null } | undefined;
    const accountId = (
      accountRow?.value ||
      settingsAddr?.addr ||
      ""
    )
      .trim()
      .toLowerCase();

    const items = db
      .prepare(
        `SELECT id, notes_json AS notesJson, primary_to AS primaryTo,
                selected_recipient AS selectedRecipient
         FROM tracker_items
         WHERE notes_json IS NOT NULL AND notes_json LIKE '%pendingGmailDraft%'`,
      )
      .all() as Array<{
      id: number;
      notesJson: string;
      primaryTo: string | null;
      selectedRecipient: string | null;
    }>;

    const insert = db.prepare(`
      INSERT INTO gmail_drafts (
        id, item_id, account_id, kind, state, message_id_hdr,
        subject, to_addr, content_hash, created_at
      ) VALUES (?, ?, ?, ?, 'unknown', ?, ?, ?, '', ?)
    `);
    const updateNotes = db.prepare(
      `UPDATE tracker_items SET notes_json = ? WHERE id = ?`,
    );

    for (const item of items) {
      let notes: Record<string, unknown>;
      try {
        notes = JSON.parse(item.notesJson) as Record<string, unknown>;
      } catch {
        continue;
      }
      const raw = notes.pendingGmailDraft;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const pending = raw as PendingShape;
      const kind = typeof pending.kind === "string" ? pending.kind : "";
      if (!PENDING_KINDS.has(kind)) continue;
      const at =
        typeof pending.at === "string" && pending.at
          ? pending.at
          : new Date().toISOString();
      const subject =
        typeof pending.subject === "string" ? pending.subject : "";
      const toAddr =
        item.selectedRecipient || item.primaryTo || "";
      const id = randomUUID();
      try {
        insert.run(
          id,
          item.id,
          accountId,
          kind,
          `legacy:${id}`,
          subject,
          toAddr,
          at,
        );
      } catch {
        // Unique live collision — keep existing row; still clear notes.
      }
      delete notes.pendingGmailDraft;
      updateNotes.run(JSON.stringify(notes), item.id);
    }
  },
};
