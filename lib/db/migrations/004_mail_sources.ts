import type { Migration } from "./types";

/**
 * Faz 3: mail_sources, mail_fetch_failures, mail_messages identity/label/gone columns.
 * Additive only — mail_folder_cursors kept for rollback safety; runtime uses mail_sources.
 */
export const migration004MailSources: Migration = {
  version: 4,
  name: "mail_sources",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mail_sources (
        account_id TEXT NOT NULL,
        role TEXT NOT NULL,
        mailbox_path TEXT NOT NULL,
        uid_validity TEXT NOT NULL,
        last_uid INTEGER NOT NULL DEFAULT 0,
        highest_modseq TEXT,
        last_meta_scan_at TEXT,
        last_success_at TEXT,
        last_error_kind TEXT,
        PRIMARY KEY (account_id, role)
      );

      CREATE TABLE IF NOT EXISTS mail_fetch_failures (
        account_id TEXT NOT NULL,
        role TEXT NOT NULL,
        uid INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        last_error TEXT,
        first_at TEXT NOT NULL,
        last_at TEXT NOT NULL,
        abandoned INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, role, uid)
      );
    `);

    // Additive columns on mail_messages (IF NOT EXISTS via try/pragma pattern).
    const cols = db
      .prepare(`PRAGMA table_info(mail_messages)`)
      .all() as { name: string }[];
    const have = new Set(cols.map((c) => c.name));
    const add = (name: string, ddl: string) => {
      if (!have.has(name)) {
        db.exec(`ALTER TABLE mail_messages ADD COLUMN ${ddl}`);
        have.add(name);
      }
    };

    add("account_id", "account_id TEXT");
    add("gm_msgid", "gm_msgid TEXT");
    add("labels_json", "labels_json TEXT");
    add("direction", "direction TEXT");
    add("internal_date", "internal_date TEXT");
    add("header_date", "header_date TEXT");
    add("in_reply_to", "in_reply_to TEXT");
    add("references_hdr", "references_hdr TEXT");
    add("auto_flags", "auto_flags TEXT");
    add("gone_at", "gone_at TEXT");
    add("gone_reason", "gone_reason TEXT");
    add("body_state", "body_state TEXT NOT NULL DEFAULT 'ok'");

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS mail_messages_gm_uq
        ON mail_messages(account_id, gm_msgid)
        WHERE gm_msgid IS NOT NULL;
      CREATE INDEX IF NOT EXISTS mail_messages_thread_idx
        ON mail_messages(thread_id);
      CREATE INDEX IF NOT EXISTS mail_messages_account_idx
        ON mail_messages(account_id);
      CREATE INDEX IF NOT EXISTS mail_messages_derive_idx
        ON mail_messages(derive_state)
        WHERE derive_state <> 'done';
    `);

    // Backfill account_id + direction from settings; migrate cursors → mail_sources.
    const settings = db
      .prepare(
        `SELECT lower(trim(gmail_address)) AS addr FROM settings WHERE id = 1`,
      )
      .get() as { addr: string | null } | undefined;
    const accountId = (settings?.addr || "").trim();

    if (accountId) {
      db.prepare(
        `INSERT INTO app_meta (key, value) VALUES ('account_id', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE app_meta.value = '' OR app_meta.value IS NULL`,
      ).run(accountId);

      db.prepare(
        `UPDATE mail_messages
         SET account_id = ?
         WHERE account_id IS NULL OR account_id = ''`,
      ).run(accountId);

      db.prepare(
        `UPDATE mail_messages
         SET direction = CASE
           WHEN lower(trim(from_addr)) = ? THEN
             CASE
               WHEN instr(lower(to_addr), ?) > 0 THEN 'self'
               ELSE 'out'
             END
           ELSE 'in'
         END
         WHERE direction IS NULL OR direction = ''`,
      ).run(accountId, accountId);
    }

    // Existing rows are already derived.
    try {
      db.exec(
        `UPDATE mail_messages SET derive_state = 'done'
         WHERE derive_state IS NULL OR derive_state = ''`,
      );
    } catch {
      /* ignore */
    }

    const cursors = db
      .prepare(
        `SELECT folder, mailbox_path, uid_validity, last_uid
         FROM mail_folder_cursors`,
      )
      .all() as {
      folder: string;
      mailbox_path: string;
      uid_validity: string;
      last_uid: number;
    }[];

    if (accountId && cursors.length) {
      const ins = db.prepare(
        `INSERT OR IGNORE INTO mail_sources
          (account_id, role, mailbox_path, uid_validity, last_uid)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const c of cursors) {
        const role =
          c.folder === "SENT" || c.folder === "sent"
            ? "sent"
            : c.folder === "INBOX" || c.folder === "inbox"
              ? "inbox"
              : null;
        if (!role) continue;
        ins.run(
          accountId,
          role,
          c.mailbox_path,
          c.uid_validity || "0",
          c.last_uid || 0,
        );
      }
    }
  },
};
