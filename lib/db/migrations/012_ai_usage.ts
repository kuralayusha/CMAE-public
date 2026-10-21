import type { Migration } from "./types";

/**
 * AI usage measurement + response cache + telemetry consent.
 * - ai_usage_events: counters and labels only (never prompt/response text);
 *   `uploaded_at` makes it the upload queue. Not wiped on account switch.
 * - ai_response_cache: app-side prompt→response cache (contains mail-derived
 *   text → wiped on account switch / onboarding wipe). Never uploaded.
 * - settings.usage_telemetry_enabled: upload consent (default on).
 * Additive only.
 */
export const migration012AiUsage: Migration = {
  version: 12,
  name: "ai_usage",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_usage_events (
        event_id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        feature TEXT NOT NULL,
        sync_mode TEXT,
        model TEXT NOT NULL,
        price_version TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost_micro_usd INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        usage_missing INTEGER NOT NULL DEFAULT 0,
        cache_hit INTEGER NOT NULL DEFAULT 0,
        saved_input_tokens INTEGER NOT NULL DEFAULT 0,
        saved_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
        uploaded_at TEXT
      );
      CREATE INDEX IF NOT EXISTS ai_usage_events_pending_idx
        ON ai_usage_events (uploaded_at, ts);

      CREATE TABLE IF NOT EXISTS ai_response_cache (
        key TEXT PRIMARY KEY,
        feature TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        response TEXT NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_hit_at INTEGER NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        ttl_at INTEGER NOT NULL,
        orig_input_tokens INTEGER NOT NULL DEFAULT 0,
        orig_cost_micro_usd INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS ai_response_cache_lru_idx
        ON ai_response_cache (last_hit_at);
    `);

    const cols = new Set(
      (db.prepare(`PRAGMA table_info(settings)`).all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    if (!cols.has("usage_telemetry_enabled")) {
      db.exec(
        `ALTER TABLE settings ADD COLUMN usage_telemetry_enabled INTEGER NOT NULL DEFAULT 1`,
      );
    }
  },
};
