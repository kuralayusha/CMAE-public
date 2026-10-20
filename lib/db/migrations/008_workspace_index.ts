import type { Migration } from "./types";

/**
 * Faz 7: disk-derived workspace index (files + folders).
 * Additive — has_* draft columns remain until Faz 8 cleanup.
 */
export const migration008WorkspaceIndex: Migration = {
  version: 8,
  name: "workspace_index",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_files (
        folder TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT,
        mtime_ms INTEGER,
        size INTEGER,
        subject TEXT,
        content_hash TEXT,
        meta_json TEXT,
        PRIMARY KEY (folder, name)
      );

      CREATE INDEX IF NOT EXISTS workspace_files_folder_idx
        ON workspace_files(folder);

      CREATE INDEX IF NOT EXISTS workspace_files_kind_idx
        ON workspace_files(folder, kind);

      CREATE TABLE IF NOT EXISTS workspace_folders (
        folder TEXT PRIMARY KEY,
        present INTEGER NOT NULL,
        scanned_at TEXT
      );
    `);
  },
};
