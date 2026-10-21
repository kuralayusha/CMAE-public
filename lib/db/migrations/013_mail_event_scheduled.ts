import type { Migration } from "./types";

/**
 * Stage 3 optional interview / meeting day on mail_events (EVENTS_PROMPT_VERSION 2).
 */
export const migration013MailEventScheduled: Migration = {
  version: 13,
  name: "mail_event_scheduled",
  up(db) {
    const cols = new Set(
      (
        db.prepare(`PRAGMA table_info(mail_events)`).all() as {
          name: string;
        }[]
      ).map((c) => c.name),
    );
    if (!cols.has("scheduled_at")) {
      db.exec(`ALTER TABLE mail_events ADD COLUMN scheduled_at TEXT`);
    }
  },
};
