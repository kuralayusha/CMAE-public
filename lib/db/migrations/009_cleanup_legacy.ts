import type { Migration } from "./types";

/**
 * Faz 8: destructive cleanup after dual-write period.
 * - Final tracker_item_mails → mail_assignments backfill, then DROP
 * - Drop has_*_draft columns (index + gmail_drafts are authoritative)
 * - message_id unique → non-unique (gm_msgid is identity)
 * Pre-migration backup via migrate.ts → cmae.db.pre-v9
 */
export const migration009CleanupLegacy: Migration = {
  version: 9,
  name: "cleanup_legacy",
  up(db) {
    const hasLegacy = db
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='tracker_item_mails'`,
      )
      .get() as { ok: number } | undefined;

    if (hasLegacy) {
      // 1) Final assignment backfill from legacy junction.
      // Ambiguous multi-item links: item with most legacy links wins.
      const legacy = db
        .prepare(
          `SELECT mail_id AS mailId, item_id AS itemId FROM tracker_item_mails`,
        )
        .all() as Array<{ mailId: number; itemId: number }>;

      const byMail = new Map<number, number[]>();
      for (const row of legacy) {
        const list = byMail.get(row.mailId) || [];
        list.push(row.itemId);
        byMail.set(row.mailId, list);
      }

      const itemMailCount = new Map<number, number>();
      for (const items of byMail.values()) {
        for (const id of items) {
          itemMailCount.set(id, (itemMailCount.get(id) || 0) + 1);
        }
      }

      const insertAssign = db.prepare(
        `INSERT OR IGNORE INTO mail_assignments
           (mail_id, item_id, source, confidence, locked, assigned_rev)
         VALUES (?, ?, 'legacy', NULL, 0, 0)`,
      );

      for (const [mailId, itemIds] of byMail) {
        const existing = db
          .prepare(`SELECT 1 AS ok FROM mail_assignments WHERE mail_id = ?`)
          .get(mailId) as { ok: number } | undefined;
        if (existing) continue;

        const unique = [...new Set(itemIds)];
        unique.sort(
          (a, b) => (itemMailCount.get(b) || 0) - (itemMailCount.get(a) || 0),
        );
        insertAssign.run(mailId, unique[0]!);
      }

      // 2) Drop legacy junction
      db.exec(`DROP TABLE IF EXISTS tracker_item_mails`);
    }

    // 3) message_id: unique → non-unique index
    db.exec(`DROP INDEX IF EXISTS mail_messages_message_id_uq`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS mail_messages_message_id_idx ON mail_messages(message_id)`,
    );

    // 4) Drop has_* draft columns when present (SQLite 3.35+)
    const cols = db
      .prepare(`PRAGMA table_info(tracker_items)`)
      .all() as { name: string }[];
    const have = new Set(cols.map((c) => c.name));
    for (const col of [
      "has_follow_up_draft",
      "has_thanks_draft",
      "has_reply_draft",
    ]) {
      if (have.has(col)) {
        db.exec(`ALTER TABLE tracker_items DROP COLUMN ${col}`);
      }
    }
  },
};
