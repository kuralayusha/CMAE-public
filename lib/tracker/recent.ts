/**
 * Tracker "Recent" feed — highlight strip after sync.
 *
 * Product rules:
 * - Mirror, not a move: items stay in their normal status sections.
 * - Syncs merge: same item_id upserts and bumps touched_at; new ids append.
 * - Never reset the feed on a new sync.
 * - Leave when touched_at is older than RECENT_TTL_MS, or the user clears.
 * - Display cap RECENT_DISPLAY_CAP (oldest beyond the cap stay until TTL prune).
 * - Hard sync does not flood the strip (only new_item is recorded there).
 */

import type Database from "better-sqlite3";
import { getSqlite } from "@/lib/db/client";

export const RECENT_TTL_MS = 48 * 60 * 60 * 1000;
export const RECENT_DISPLAY_CAP = 25;

export type RecentReason = "new_item" | "mail_attached";

export type RecentEntry = {
  itemId: number;
  reason: RecentReason;
  firstAt: string;
  touchedAt: string;
  detail: Record<string, unknown> | null;
};

function parseDetail(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Upsert one item into the recent feed (merge / bump). */
export function noteRecentItem(
  itemId: number,
  reason: RecentReason,
  opts?: {
    detail?: Record<string, unknown>;
    db?: Database.Database;
    now?: Date;
  },
): void {
  if (!Number.isFinite(itemId) || itemId <= 0) return;
  const db = opts?.db ?? getSqlite();
  const now = (opts?.now ?? new Date()).toISOString();
  const detailJson = opts?.detail ? JSON.stringify(opts.detail) : null;
  try {
    db.prepare(
      `INSERT INTO tracker_recent (item_id, reason, detail_json, first_at, touched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET
         reason = CASE
           WHEN excluded.reason = 'new_item' THEN 'new_item'
           ELSE tracker_recent.reason
         END,
         detail_json = COALESCE(excluded.detail_json, tracker_recent.detail_json),
         touched_at = excluded.touched_at`,
    ).run(itemId, reason, detailJson, now, now);
  } catch {
    /* table missing mid-migrate — ignore */
  }
}

/** Drop rows past TTL. Safe to call on every list read. */
export function pruneRecentItems(
  db: Database.Database = getSqlite(),
  nowMs: number = Date.now(),
): number {
  const cutoff = new Date(nowMs - RECENT_TTL_MS).toISOString();
  try {
    const r = db
      .prepare(`DELETE FROM tracker_recent WHERE touched_at < ?`)
      .run(cutoff);
    return r.changes;
  } catch {
    return 0;
  }
}

/** Clear the whole strip (user action). */
export function clearRecentItems(db: Database.Database = getSqlite()): number {
  try {
    const r = db.prepare(`DELETE FROM tracker_recent`).run();
    return r.changes;
  } catch {
    return 0;
  }
}

export function listRecentEntries(
  opts?: { db?: Database.Database; nowMs?: number; limit?: number },
): RecentEntry[] {
  const db = opts?.db ?? getSqlite();
  const nowMs = opts?.nowMs ?? Date.now();
  pruneRecentItems(db, nowMs);
  const limit = opts?.limit ?? RECENT_DISPLAY_CAP;
  try {
    const rows = db
      .prepare(
        `SELECT item_id AS itemId, reason, detail_json AS detailJson,
                first_at AS firstAt, touched_at AS touchedAt
         FROM tracker_recent
         ORDER BY touched_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      itemId: number;
      reason: string;
      detailJson: string | null;
      firstAt: string;
      touchedAt: string;
    }>;
    return rows.map((r) => ({
      itemId: r.itemId,
      reason: r.reason === "new_item" ? "new_item" : "mail_attached",
      firstAt: r.firstAt,
      touchedAt: r.touchedAt,
      detail: parseDetail(r.detailJson),
    }));
  } catch {
    return [];
  }
}
