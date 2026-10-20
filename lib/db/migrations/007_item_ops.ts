import type { Migration } from "./types";

/**
 * Faz 6: row-level long-op locks (prepare / draft) replacing busyId + draft-inflight alone.
 */
export const migration007ItemOps: Migration = {
  version: 7,
  name: "item_ops",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS item_ops (
        item_id INTEGER NOT NULL,
        op TEXT NOT NULL,
        owner TEXT NOT NULL,
        started_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (item_id, op)
      );
      CREATE INDEX IF NOT EXISTS item_ops_expires_idx ON item_ops(expires_at);
    `);
  },
};
