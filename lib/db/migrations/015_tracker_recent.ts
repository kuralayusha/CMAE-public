import type { Migration } from "./types";

/**
 * Sync "Recent" highlight strip: items newly created or that gained mail.
 * Rows stay in their normal status sections too — this table is a mirror.
 */
export const migration015TrackerRecent: Migration = {
  version: 15,
  name: "tracker_recent",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tracker_recent (
        item_id INTEGER PRIMARY KEY REFERENCES tracker_items(id) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        detail_json TEXT,
        first_at TEXT NOT NULL,
        touched_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tracker_recent_touched_idx
        ON tracker_recent(touched_at DESC);
    `);
  },
};
