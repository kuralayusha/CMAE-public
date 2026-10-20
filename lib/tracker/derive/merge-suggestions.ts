/**
 * Twin merge suggestions (K3) — replaces automatic collapseInactiveActiveTwins.
 */

import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bumpTrackerRevision, getTrackerRevision } from "@/lib/db/revision";
import { mergeProposals, trackerItems } from "@/lib/db/schema";
import { emitTrackerEvent } from "../events-bus";
import { sameCompanyIdentity, samePrimaryEmail } from "../identity";

export type MergeConflict = {
  field: string;
  winner: string | null;
  loser: string | null;
};

function userConflicts(
  a: typeof trackerItems.$inferSelect,
  b: typeof trackerItems.$inferSelect,
): MergeConflict[] {
  const conflicts: MergeConflict[] = [];
  const aState = a.userState || (a.status === "inactive" ? "inactive" : "active");
  const bState = b.userState || (b.status === "inactive" ? "inactive" : "active");
  if (aState !== bState) {
    conflicts.push({
      field: "user_state",
      winner: aState,
      loser: bState,
    });
  }
  const aRec = a.selectedRecipient || null;
  const bRec = b.selectedRecipient || null;
  if (aRec && bRec && aRec.toLowerCase() !== bRec.toLowerCase()) {
    conflicts.push({
      field: "selected_recipient",
      winner: aRec,
      loser: bRec,
    });
  }
  return conflicts;
}

/**
 * Soft twin detection: create merge_proposals instead of deleting rows.
 * Never auto-merges. Returns number of new proposals.
 */
export function suggestTwinMerges(): number {
  const db = getDb();
  const rows = db
    .select()
    .from(trackerItems)
    .all()
    .filter((r) => !r.deletedAt);

  const inactive = rows.filter(
    (r) => r.userState === "inactive" || r.status === "inactive",
  );
  const active = rows.filter(
    (r) => r.userState !== "inactive" && r.status !== "inactive",
  );

  let created = 0;
  const rev = getTrackerRevision();
  const now = new Date().toISOString();

  for (const inv of inactive) {
    const twins = active.filter(
      (a) =>
        sameCompanyIdentity(a.company, inv.company) ||
        samePrimaryEmail(a.primaryTo, inv.primaryTo),
    );
    for (const twin of twins) {
      // Prefer inactive as winner id (user paused it); twin is loser candidate.
      const winnerId = inv.id;
      const loserId = twin.id;

      const existing = db
        .select()
        .from(mergeProposals)
        .where(
          and(
            eq(mergeProposals.winnerId, winnerId),
            eq(mergeProposals.loserId, loserId),
            eq(mergeProposals.state, "pending"),
          ),
        )
        .get();
      if (existing) continue;

      const conflicts = userConflicts(inv, twin);
      // Always propose — even without conflicts (user confirms).
      // Architecture: email alone is never auto-merge reason; company identity suspicion → ask.
      const id = randomUUID();
      db.insert(mergeProposals)
        .values({
          id,
          winnerId,
          loserId,
          origin: "twin_suggestion",
          conflictsJson: JSON.stringify(conflicts),
          state: "pending",
          createdRev: rev,
          createdAt: now,
          resolvedAt: null,
        })
        .run();
      created += 1;
      const nextRev = bumpTrackerRevision("mutation", "upsert", [
        winnerId,
        loserId,
      ]);
      emitTrackerEvent({
        type: "merge_proposal",
        rev: nextRev,
        proposalId: id,
        itemIds: [winnerId, loserId],
      });
    }
  }
  return created;
}

/**
 * Former auto-collapse — now only emits proposals. Always returns 0 deleted.
 */
export function collapseInactiveActiveTwinsDisabled(): number {
  suggestTwinMerges();
  return 0;
}
