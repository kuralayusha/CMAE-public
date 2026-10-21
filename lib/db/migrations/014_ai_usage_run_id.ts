import type { Migration } from "./types";

/**
 * Tag AI usage events with a logical run id so many LLM calls that belong to
 * one sync / research / translate batch can be aggregated server-side.
 */
export const migration014AiUsageRunId: Migration = {
  version: 14,
  name: "ai_usage_run_id",
  up(db) {
    const cols = new Set(
      (
        db.prepare(`PRAGMA table_info(ai_usage_events)`).all() as {
          name: string;
        }[]
      ).map((c) => c.name),
    );
    if (!cols.has("run_id")) {
      db.exec(`ALTER TABLE ai_usage_events ADD COLUMN run_id TEXT`);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS ai_usage_events_run_idx
        ON ai_usage_events (run_id, ts);
    `);
  },
};
