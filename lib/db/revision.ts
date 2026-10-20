import type Database from "better-sqlite3";
import { getSqlite } from "./client";
import { notifyTrackerRevision } from "@/lib/tracker/events-bus";

export type RevisionSource =
  | "sync"
  | "mutation"
  | "research"
  | "fs"
  | "drafts"
  | "migration"
  | "reset"
  | "account_switch";

export type RevisionKind = "upsert" | "delete" | "merge" | "global";

const CHANGELOG_KEEP = 2000;

export function getTrackerRevision(db: Database.Database = getSqlite()): number {
  try {
    const row = db
      .prepare(`SELECT value FROM app_meta WHERE key = 'tracker_revision'`)
      .get() as { value: string } | undefined;
    if (!row) return 0;
    const n = Number.parseInt(row.value, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export type TrackerChangeRow = {
  rev: number;
  at: string;
  source: string;
  kind: string;
  itemIds: number[];
};

export function listTrackerChangesSince(
  afterRev: number,
  db: Database.Database = getSqlite(),
): TrackerChangeRow[] {
  try {
    const rows = db
      .prepare(
        `SELECT rev, at, source, kind, item_ids AS itemIds
         FROM tracker_changes
         WHERE rev > ?
         ORDER BY rev ASC`,
      )
      .all(afterRev) as {
      rev: number;
      at: string;
      source: string;
      kind: string;
      itemIds: string;
    }[];
    return rows.map((r) => {
      let itemIds: number[] = [];
      try {
        const parsed = JSON.parse(r.itemIds) as unknown;
        if (Array.isArray(parsed)) {
          itemIds = parsed.filter((x): x is number => typeof x === "number");
        }
      } catch {
        itemIds = [];
      }
      return {
        rev: r.rev,
        at: r.at,
        source: r.source,
        kind: r.kind,
        itemIds,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Bump tracker_revision and append changelog. Safe inside better-sqlite3 transactions
 * (same connection). Notifies the in-process SSE bus after commit of the current
 * statement batch — callers inside a transaction should expect notify after the
 * outer transaction commits; we notify immediately which is fine for same-process
 * listeners once the tx commits (listeners typically re-fetch).
 */
export function bumpRevision(
  db: Database.Database,
  source: RevisionSource | string,
  kind: RevisionKind | string = "global",
  itemIds: number[] | "all" = "all",
): number {
  const now = new Date().toISOString();
  const current = getTrackerRevision(db);
  const next = current + 1;
  const idsJson = JSON.stringify(itemIds === "all" ? [] : itemIds);

  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES ('tracker_revision', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(next));

  db.prepare(
    `INSERT INTO tracker_changes (rev, at, source, kind, item_ids)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(next, now, source, kind, idsJson);

  db.prepare(`DELETE FROM tracker_changes WHERE rev <= ?`).run(
    next - CHANGELOG_KEEP,
  );

  notifyTrackerRevision({
    rev: next,
    source: String(source),
    kind: String(kind),
    itemIds: itemIds === "all" ? "all" : itemIds,
  });

  return next;
}

/** Convenience: open handle + bump. */
export function bumpTrackerRevision(
  source: RevisionSource | string,
  kind: RevisionKind | string = "global",
  itemIds: number[] | "all" = "all",
): number {
  return bumpRevision(getSqlite(), source, kind, itemIds);
}
