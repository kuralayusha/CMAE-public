/**
 * Bulk inactive / active for tracker rows.
 * Faz 4: user_state overlay; status comes from effective() on read.
 * Auto twin collapse disabled (K3) — see suggestTwinMerges.
 */

import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bumpTrackerRevision } from "@/lib/db/revision";
import { trackerItems } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { suggestTwinMerges } from "./derive/merge-suggestions";
import { effective, factsFromItemRow } from "./derive/effective";
import { getSettingsRow } from "@/lib/settings/service";

function isInactiveRow(row: {
  userState: string | null;
  status: string;
}): boolean {
  return row.userState === "inactive" || row.status === "inactive";
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
  const touched: number[] = [];
  for (const row of rows) {
    if (isInactiveRow(row)) continue;
    db.update(trackerItems)
      .set({
        userState: "inactive",
        userVersion: (row.userVersion || 1) + 1,
        status: "inactive",
        updatedAt: now,
      })
      .where(eq(trackerItems.id, row.id))
      .run();
    touched.push(row.id);
    updated += 1;
  }
  if (updated) {
    bumpTrackerRevision("mutation", "upsert", touched);
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

  const followUpDays = getSettingsRow()?.followUpDays ?? 5;
  let updated = 0;
  const now = new Date().toISOString();
  const touched: number[] = [];
  for (const row of rows) {
    if (!isInactiveRow(row)) continue;
    const facts = factsFromItemRow(row);
    const resolved = effective({
      facts,
      userState: "active",
      followUpDays,
    });
    db.update(trackerItems)
      .set({
        userState: "active",
        userVersion: (row.userVersion || 1) + 1,
        status: resolved.status,
        waitingOn: resolved.waitingOn,
        nextFollowUpAt: resolved.nextFollowUpAt,
        ignored: resolved.ignored ? 1 : 0,
        updatedAt: now,
      })
      .where(eq(trackerItems.id, row.id))
      .run();
    touched.push(row.id);
    updated += 1;
  }
  if (updated) {
    bumpTrackerRevision("mutation", "upsert", touched);
  }
  return { updated };
}

export function assertItemActiveForDrafts(itemId: number): void {
  const row = getDb()
    .select({
      status: trackerItems.status,
      userState: trackerItems.userState,
    })
    .from(trackerItems)
    .where(eq(trackerItems.id, itemId))
    .get();
  if (row && isInactiveRow(row)) {
    throw new Error(t("tracker.error.inactive"));
  }
}

/**
 * @deprecated Auto-collapse removed (K3). Emits merge_proposals only; returns 0.
 */
export function collapseInactiveActiveTwins(): number {
  suggestTwinMerges();
  return 0;
}
