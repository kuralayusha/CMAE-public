/**
 * Bulk inactive / active for tracker rows.
 * Inactive survives sync rebuild; activate restores prior status until next sync reclassifies.
 */

import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { trackerItems } from "@/lib/db/schema";
import type { TrackerStatus } from "./types";
import { TRACKER_STATUSES } from "./types";

function parseNotes(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isStatus(v: unknown): v is TrackerStatus {
  return (
    typeof v === "string" &&
    (TRACKER_STATUSES as readonly string[]).includes(v)
  );
}

export function setItemsInactive(ids: number[]): { updated: number } {
  const uniq = [...new Set(ids.filter((n) => Number.isFinite(n)))];
  if (!uniq.length) return { updated: 0 };

  const db = getDb();
  const rows = db
    .select()
    .from(trackerItems)
    .where(inArray(trackerItems.id, uniq))
    .all();

  let updated = 0;
  const now = new Date().toISOString();
  for (const row of rows) {
    if (row.status === "inactive") continue;
    const notes = parseNotes(row.notesJson);
    notes.statusBeforeInactive = row.status;
    db.update(trackerItems)
      .set({
        status: "inactive",
        notesJson: JSON.stringify(notes),
        updatedAt: now,
      })
      .where(inArray(trackerItems.id, [row.id]))
      .run();
    updated += 1;
  }
  return { updated };
}

export function setItemsActive(ids: number[]): { updated: number } {
  const uniq = [...new Set(ids.filter((n) => Number.isFinite(n)))];
  if (!uniq.length) return { updated: 0 };

  const db = getDb();
  const rows = db
    .select()
    .from(trackerItems)
    .where(inArray(trackerItems.id, uniq))
    .all();

  let updated = 0;
  const now = new Date().toISOString();
  for (const row of rows) {
    if (row.status !== "inactive") continue;
    const notes = parseNotes(row.notesJson);
    const prior = notes.statusBeforeInactive;
    const restored: TrackerStatus =
      isStatus(prior) && prior !== "inactive" ? prior : "in_progress";
    delete notes.statusBeforeInactive;
    db.update(trackerItems)
      .set({
        status: restored,
        notesJson: JSON.stringify(notes),
        updatedAt: now,
      })
      .where(inArray(trackerItems.id, [row.id]))
      .run();
    updated += 1;
  }
  return { updated };
}

export function assertItemActiveForDrafts(itemId: number): void {
  const row = getDb()
    .select({ status: trackerItems.status })
    .from(trackerItems)
    .where(eq(trackerItems.id, itemId))
    .get();
  if (row?.status === "inactive") {
    throw new Error("Cannot prepare mail for inactive applications");
  }
}
