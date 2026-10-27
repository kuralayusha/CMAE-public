import type { Migration } from "./types";

/**
 * Cursor SDK → OpenRouter.
 * - settings: encrypted OpenRouter key + the two model slots (fast / smart).
 *   `cursor_api_key_enc` is blanked: that secret is useless now and should not
 *   linger on disk. The column itself stays (SQLite drop-column is not worth it).
 * - Every usage row written before this migration came from the Cursor SDK;
 *   rows with an empty model are labelled `composer-2.5`.
 * Additive otherwise.
 *
 * Numbered 17 on purpose: `feature/filler-assisted-apply` owns 016_filler, and
 * databases that ever ran that branch already have version 16 recorded — a
 * second 016 would be skipped as "already applied" and the columns never created.
 */
export const migration017OpenRouter: Migration = {
  version: 17,
  name: "openrouter",
  up(db) {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(settings)`).all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    for (const col of [
      "openrouter_api_key_enc",
      "llm_model_fast",
      "llm_model_smart",
    ]) {
      if (!cols.has(col)) db.exec(`ALTER TABLE settings ADD COLUMN ${col} TEXT`);
    }
    if (cols.has("cursor_api_key_enc")) {
      db.exec(`UPDATE settings SET cursor_api_key_enc = NULL`);
    }
    db.exec(
      `UPDATE ai_usage_events SET model = 'composer-2.5' WHERE model IS NULL OR TRIM(model) = ''`,
    );
  },
};
