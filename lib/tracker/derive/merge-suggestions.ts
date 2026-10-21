/**
 * Twin merge suggestions (K3) — replaces automatic collapseInactiveActiveTwins.
 */

import { randomUUID } from "crypto";
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
export function suggestTwinMerges(extraPairs: [number, number][] = []): number {
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

  const pairs: [typeof rows[number], typeof rows[number]][] = [];
  for (const inv of inactive) {
    for (const twin of active) {
      if (
        sameCompanyIdentity(twin.company, inv.company) ||
        samePrimaryEmail(twin.primaryTo, inv.primaryTo)
      ) {
        // Prefer inactive as winner id (user paused it); twin is loser candidate.
        pairs.push([inv, twin]);
      }
    }
  }
  // Active rows of the same employer (e.g. created before conversation
  // identity existed): same company only — a shared ATS address is not enough.
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i]!;
      const b = active[j]!;
      if (!sameCompanyIdentity(a.company, b.company)) continue;
      pairs.push(a.id < b.id ? [a, b] : [b, a]);
    }
  }

  const live = new Map(rows.map((r) => [r.id, r]));
  for (const [x, y] of extraPairs) {
    const a = live.get(x);
    const b = live.get(y);
    if (a && b && a.id !== b.id) pairs.push(a.id < b.id ? [a, b] : [b, a]);
  }

  let created = 0;
  const rev = getTrackerRevision();
  const now = new Date().toISOString();
  const known = new Set(
    db
      .select()
      .from(mergeProposals)
      .all()
      .map((p) => [p.winnerId, p.loserId].sort((x, y) => x - y).join(":")),
  );

  for (const [winner, loser] of pairs) {
    const winnerId = winner.id;
    const loserId = loser.id;
    // Any earlier proposal for this pair (pending, accepted or rejected) wins:
    // a "keep separate" answer must not come back on every sync.
    const key = [winnerId, loserId].sort((x, y) => x - y).join(":");
    if (known.has(key)) continue;
    known.add(key);

    const conflicts = userConflicts(winner, loser);
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
  return created;
}

/**
 * Former auto-collapse — now only emits proposals. Always returns 0 deleted.
 */
export function collapseInactiveActiveTwinsDisabled(): number {
  suggestTwinMerges();
  return 0;
}
