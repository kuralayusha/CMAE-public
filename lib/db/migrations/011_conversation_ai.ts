import type { Migration } from "./types";

/**
 * Conversation AI stages, wave 2 (architecture §2.6.6–§2.6.10):
 * - conversation_analysis.state / attempts / error: triage failures are kept
 *   as `failed` (unverified, retried) instead of guessed data
 * - mail_conversations.events_*: stage 3 cache key (fingerprint + prompt
 *   version) and failure state per conversation
 * - tracker_items.channel / channel_kind: intermediary (ATS / agency / job
 *   board) of the row — one row per actual employer
 * Additive only.
 */
export const migration011ConversationAi: Migration = {
  version: 11,
  name: "conversation_ai",
  up(db) {
    const cols = (table: string) =>
      new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          (c) => c.name,
        ),
      );
    const add = (table: string, have: Set<string>, name: string, ddl: string) => {
      if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    };

    const analysis = cols("conversation_analysis");
    add("conversation_analysis", analysis, "state", "state TEXT NOT NULL DEFAULT 'ok'");
    add("conversation_analysis", analysis, "attempts", "attempts INTEGER NOT NULL DEFAULT 0");
    add("conversation_analysis", analysis, "error", "error TEXT");

    const convs = cols("mail_conversations");
    add("mail_conversations", convs, "events_fingerprint", "events_fingerprint TEXT");
    add("mail_conversations", convs, "events_prompt_version", "events_prompt_version INTEGER");
    add("mail_conversations", convs, "events_state", "events_state TEXT");
    add("mail_conversations", convs, "events_attempts", "events_attempts INTEGER NOT NULL DEFAULT 0");
    add("mail_conversations", convs, "events_at", "events_at TEXT");

    const items = cols("tracker_items");
    add("tracker_items", items, "channel", "channel TEXT");
    add("tracker_items", items, "channel_kind", "channel_kind TEXT");
  },
};
