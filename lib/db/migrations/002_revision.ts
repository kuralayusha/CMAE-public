import type { Migration } from "./types";

/** app_meta + tracker_changes for revision / SSE / ETag. */
export const migration002Revision: Migration = {
  version: 2,
  name: "revision",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tracker_changes (
        rev INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        item_ids TEXT NOT NULL DEFAULT '[]'
      );
    `);

    db.prepare(
      `INSERT OR IGNORE INTO app_meta (key, value) VALUES ('tracker_revision', '0')`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO app_meta (key, value) VALUES ('db_epoch', '0')`,
    ).run();
  },
};
