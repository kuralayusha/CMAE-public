/**
 * Bulk inactive / active for tracker rows.
 * Faz 6: single transaction via withItemsTx; user_state only (facts untouched).
 * Auto twin collapse disabled (K3) — see suggestTwinMerges.
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { trackerItems } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { getStatusSettings } from "@/lib/settings/service";
import { suggestTwinMerges } from "./derive/merge-suggestions";
import { effective, factsFromItemRow } from "./derive/effective";
import { withItemsTx, type UserColumnPatch } from "./item-tx";

function isInactiveRow(row: {
  userState: string | null;
  status: string;
}): boolean {
  return row.userState === "inactive" || row.status === "inactive";
}

export function setItemsInactive(ids: number[]): { updated: number; rev: number } {
  const uniq = [...new Set(ids.filter((n) => Number.isFinite(n)))];
  if (!uniq.length) return { updated: 0, rev: 0 };

  const { rev, touched } = withItemsTx(uniq, { source: "mutation" }, (_sqlite, rows) => {
    const patches = new Map<number, UserColumnPatch>();
    for (const [id, row] of rows) {
      if (isInactiveRow(row)) continue;
      patches.set(id, {
        userState: "inactive",
        status: "inactive",
      });
    }
    return { patches };
  });

  return { updated: touched.length, rev };
}

export function setItemsActive(ids: number[]): { updated: number; rev: number } {
  const uniq = [...new Set(ids.filter((n) => Number.isFinite(n)))];
  if (!uniq.length) return { updated: 0, rev: 0 };

  const statusSettings = getStatusSettings();

  const { rev, touched } = withItemsTx(uniq, { source: "mutation" }, (_sqlite, rows) => {
    const patches = new Map<number, UserColumnPatch>();
    for (const [id, row] of rows) {
      if (!isInactiveRow(row)) continue;
      const facts = factsFromItemRow(row);
      const resolved = effective({
        facts,
        userState: "active",
        ...statusSettings,
      });
      patches.set(id, {
        userState: "active",
        status: resolved.status,
        waitingOn: resolved.waitingOn,
        nextFollowUpAt: resolved.nextFollowUpAt,
        ignored: resolved.ignored ? 1 : 0,
      });
    }
    return { patches };
  });

  return { updated: touched.length, rev };
}

export function assertItemActiveForDrafts(itemId: number): void {
  const row = getDb()
    .select({
      status: trackerItems.status,
      userState: trackerItems.userState,
      deletedAt: trackerItems.deletedAt,
    })
    .from(trackerItems)
    .where(eq(trackerItems.id, itemId))
    .get();
  if (!row || row.deletedAt) {
    throw new Error(t("tracker.error.notFound"));
  }
  if (isInactiveRow(row)) {
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
