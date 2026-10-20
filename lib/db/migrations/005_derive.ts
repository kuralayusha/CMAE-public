import type { Migration } from "./types";

/**
 * Faz 4: mail_assignments / unassigned / intents, item fact+user columns,
 * merge_proposals, legacy backfill from tracker_item_mails.
 * Additive only — tracker_item_mails kept for dual-write / rollback.
 */
export const migration005Derive: Migration = {
  version: 5,
  name: "derive",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mail_assignments (
        mail_id INTEGER PRIMARY KEY REFERENCES mail_messages(id) ON DELETE CASCADE,
        item_id INTEGER NOT NULL REFERENCES tracker_items(id),
        source TEXT NOT NULL,
        confidence REAL,
        locked INTEGER NOT NULL DEFAULT 0,
        assigned_rev INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS mail_assignments_item_idx
        ON mail_assignments(item_id);

      CREATE TABLE IF NOT EXISTS mail_unassigned (
        mail_id INTEGER PRIMARY KEY REFERENCES mail_messages(id) ON DELETE CASCADE,
        reason TEXT NOT NULL,
        since TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS mail_intents (
        mail_id INTEGER PRIMARY KEY REFERENCES mail_messages(id) ON DELETE CASCADE,
        intent TEXT NOT NULL,
        waiting_until TEXT,
        confidence REAL,
        source TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS merge_proposals (
        id TEXT PRIMARY KEY,
        winner_id INTEGER NOT NULL REFERENCES tracker_items(id),
        loser_id INTEGER NOT NULL REFERENCES tracker_items(id),
        origin TEXT NOT NULL,
        conflicts_json TEXT NOT NULL,
        state TEXT NOT NULL,
        created_rev INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS merge_proposals_state_idx
        ON merge_proposals(state);

      CREATE TABLE IF NOT EXISTS item_lineage (
        old_id INTEGER NOT NULL,
        new_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        at TEXT NOT NULL
      );
    `);

    const cols = db
      .prepare(`PRAGMA table_info(tracker_items)`)
      .all() as { name: string }[];
    const have = new Set(cols.map((c) => c.name));
    const add = (name: string, ddl: string) => {
      if (!have.has(name)) {
        db.exec(`ALTER TABLE tracker_items ADD COLUMN ${ddl}`);
        have.add(name);
      }
    };

    add("user_state", "user_state TEXT NOT NULL DEFAULT 'active'");
    add("selected_recipient", "selected_recipient TEXT");
    add("user_version", "user_version INTEGER NOT NULL DEFAULT 1");
    add("ai_status", "ai_status TEXT");
    add("last_meaningful_inbound_at", "last_meaningful_inbound_at TEXT");
    add("waiting_until", "waiting_until TEXT");
    add("last_intent", "last_intent TEXT");
    add("flags_json", "flags_json TEXT");
    add("needs_classification", "needs_classification INTEGER NOT NULL DEFAULT 0");
    add("derived_version", "derived_version INTEGER NOT NULL DEFAULT 1");
    add("derived_at", "derived_at TEXT");
    add("origin_research_job_id", "origin_research_job_id TEXT");
    add("deleted_at", "deleted_at TEXT");
    add("deleted_reason", "deleted_reason TEXT");
    add("merged_into_id", "merged_into_id INTEGER");

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS tracker_items_origin_job_uq
        ON tracker_items(origin_research_job_id)
        WHERE origin_research_job_id IS NOT NULL AND deleted_at IS NULL;
    `);

    // Backfill user_state from status='inactive'
    db.exec(`
      UPDATE tracker_items
      SET user_state = 'inactive'
      WHERE status = 'inactive' AND (user_state IS NULL OR user_state = 'active')
    `);

    // Backfill selected_recipient + origin_research_job_id from notes / researchJobId
    const items = db
      .prepare(
        `SELECT id, notes_json AS notesJson, research_job_id AS researchJobId,
                selected_recipient AS selectedRecipient,
                origin_research_job_id AS originJobId
         FROM tracker_items`,
      )
      .all() as {
      id: number;
      notesJson: string | null;
      researchJobId: string | null;
      selectedRecipient: string | null;
      originJobId: string | null;
    }[];

    const updRecipient = db.prepare(
      `UPDATE tracker_items SET selected_recipient = ? WHERE id = ?`,
    );
    const updOrigin = db.prepare(
      `UPDATE tracker_items SET origin_research_job_id = ? WHERE id = ?`,
    );

    for (const row of items) {
      if (!row.selectedRecipient && row.notesJson) {
        try {
          const notes = JSON.parse(row.notesJson) as {
            selectedRecipient?: unknown;
          };
          if (typeof notes.selectedRecipient === "string") {
            const m = notes.selectedRecipient
              .trim()
              .match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            if (m) updRecipient.run(m[0], row.id);
          }
        } catch {
          /* ignore */
        }
      }
      if (!row.originJobId && row.researchJobId) {
        updOrigin.run(row.researchJobId, row.id);
      }
    }

    // Seed ai_status from current status (except inactive overlay)
    db.exec(`
      UPDATE tracker_items
      SET ai_status = CASE
        WHEN status = 'inactive' THEN COALESCE(
          json_extract(notes_json, '$.statusBeforeInactive'),
          'in_progress'
        )
        ELSE status
      END
      WHERE ai_status IS NULL
    `);

    // Backfill mail_assignments from tracker_item_mails.
    // Ambiguous (mail → multiple items): keep the item with most mails; rest → unassigned.
    const links = db
      .prepare(
        `SELECT mail_id AS mailId, item_id AS itemId FROM tracker_item_mails`,
      )
      .all() as { mailId: number; itemId: number }[];

    const byMail = new Map<number, number[]>();
    for (const l of links) {
      const arr = byMail.get(l.mailId) || [];
      arr.push(l.itemId);
      byMail.set(l.mailId, arr);
    }

    const itemMailCount = new Map<number, number>();
    for (const l of links) {
      itemMailCount.set(l.itemId, (itemMailCount.get(l.itemId) || 0) + 1);
    }

    const revRow = db
      .prepare(`SELECT value FROM app_meta WHERE key = 'tracker_revision'`)
      .get() as { value: string } | undefined;
    const rev = Number(revRow?.value || "0") || 0;
    const now = new Date().toISOString();

    const insAssign = db.prepare(
      `INSERT OR IGNORE INTO mail_assignments
        (mail_id, item_id, source, confidence, locked, assigned_rev)
       VALUES (?, ?, 'legacy', 1.0, 0, ?)`,
    );
    for (const [mailId, itemIds] of byMail) {
      if (itemIds.length === 1) {
        insAssign.run(mailId, itemIds[0], rev);
        continue;
      }
      // Tie-break: most mails on the item wins; mail stays assigned (not unassigned).
      const winner = [...itemIds].sort(
        (a, b) => (itemMailCount.get(b) || 0) - (itemMailCount.get(a) || 0),
      )[0];
      insAssign.run(mailId, winner, rev);
      console.warn(
        `[migrate:005] ambiguous mail ${mailId}: assigned to item ${winner} (had ${itemIds.length} links)`,
      );
    }

    void now;

    db.exec(`
      UPDATE mail_messages SET derive_state = 'done'
      WHERE derive_state IS NULL OR derive_state = ''
    `);
  },
};
