/**
 * Bulk inactive / active for tracker rows.
 * Inactive survives sync rebuild; activate restores prior status until next sync reclassifies.
 */

import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { trackerItemMails, trackerItems } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { sameCompanyIdentity, samePrimaryEmail } from "./identity";
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
    throw new Error(t("tracker.error.inactive"));
  }
}

/**
 * Keep inactive, absorb mails from active twin (same company/email), delete active.
 * Fixes sync duplicates like ExampleCo (needs_action) + ExampleCo (inactive).
 */
export function collapseInactiveActiveTwins(): number {
  const db = getDb();
  const rows = db.select().from(trackerItems).all();
  const inactive = rows.filter((r) => r.status === "inactive");
  const active = rows.filter((r) => r.status !== "inactive");
  let deleted = 0;

  for (const inv of inactive) {
    const twins = active.filter(
      (a) =>
        sameCompanyIdentity(a.company, inv.company) ||
        samePrimaryEmail(a.primaryTo, inv.primaryTo),
    );
    for (const twin of twins) {
      const twinLinks = db
        .select()
        .from(trackerItemMails)
        .where(eq(trackerItemMails.itemId, twin.id))
        .all();
      const invMailIds = new Set(
        db
          .select()
          .from(trackerItemMails)
          .where(eq(trackerItemMails.itemId, inv.id))
          .all()
          .map((l) => l.mailId),
      );
      for (const link of twinLinks) {
        if (invMailIds.has(link.mailId)) continue;
        db.insert(trackerItemMails)
          .values({
            itemId: inv.id,
            mailId: link.mailId,
            role: link.role,
          })
          .run();
        invMailIds.add(link.mailId);
      }
      db.delete(trackerItemMails)
        .where(eq(trackerItemMails.itemId, twin.id))
        .run();
      db.delete(trackerItems).where(eq(trackerItems.id, twin.id)).run();
      deleted += 1;
    }
  }
  return deleted;
}
