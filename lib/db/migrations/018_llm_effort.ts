import type { Migration } from "./types";

/**
 * Model picker v2: reasoning effort per slot + per-feature choices
 * ("detailed mode"). Additive; null = built-in behaviour.
 */
export const migration018LlmEffort: Migration = {
  version: 18,
  name: "llm_effort",
  up(db) {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(settings)`).all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    for (const col of ["llm_effort_fast", "llm_effort_smart", "llm_overrides_json"]) {
      if (!cols.has(col)) db.exec(`ALTER TABLE settings ADD COLUMN ${col} TEXT`);
    }
  },
};
