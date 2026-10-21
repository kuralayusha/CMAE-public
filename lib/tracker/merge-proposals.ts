/**
 * K3 merge proposal list + respond (accept / reject).
 */

import { desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, getSqlite } from "@/lib/db/client";
import { bumpRevision, getTrackerRevision } from "@/lib/db/revision";
import {
  itemLineage,
  mailAssignments,
  mailMessages,
  mergeProposals,
  trackerItems,
} from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { emitTrackerEvent } from "./events-bus";
import { mergeItemInTx } from "./item-tx";
import { withSelectedRecipient } from "./recipients";
import type { MergeConflict } from "./derive/merge-suggestions";

export type MergeMailView = {
  subject: string;
  from: string;
  direction: string | null;
  date: string;
};

export type MergeSideView = {
  id: number;
  company: string;
  primaryTo: string | null;
  userState: string;
  status: string;
  mails: MergeMailView[];
  mailCount: number;
};

const MERGE_MAILS_PER_SIDE = 5;

export type MergeProposalView = {
  id: string;
  winnerId: number;
  loserId: number;
  origin: string;
  conflicts: MergeConflict[];
  state: string;
  createdRev: number;
  createdAt: string;
  winner: MergeSideView;
  loser: MergeSideView;
};

function parseConflicts(json: string): MergeConflict[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is MergeConflict =>
        c != null &&
        typeof c === "object" &&
        typeof (c as MergeConflict).field === "string",
    );
  } catch {
    return [];
  }
}

function loadSideMails(itemId: number): {
  mails: MergeMailView[];
  mailCount: number;
} {
  const db = getDb();
  const rows = db
    .select({
      subject: mailMessages.subject,
      from: mailMessages.fromAddr,
      direction: mailMessages.direction,
      date: mailMessages.dateIso,
    })
    .from(mailAssignments)
    .innerJoin(mailMessages, eq(mailMessages.id, mailAssignments.mailId))
    .where(eq(mailAssignments.itemId, itemId))
    .orderBy(desc(mailMessages.dateIso))
    .limit(MERGE_MAILS_PER_SIDE)
    .all();
  const count = db
    .select({ n: sql<number>`count(*)` })
    .from(mailAssignments)
    .where(eq(mailAssignments.itemId, itemId))
    .get();
  return { mails: rows, mailCount: count?.n ?? rows.length };
}

function briefItem(row: typeof trackerItems.$inferSelect): MergeSideView {
  return {
    id: row.id,
    company: row.company,
    primaryTo: row.primaryTo,
    status: row.status,
    userState:
      row.userState || (row.status === "inactive" ? "inactive" : "active"),
    ...loadSideMails(row.id),
  };
}

export function listPendingMergeProposals(): MergeProposalView[] {
  const db = getDb();
  const rows = db
    .select()
    .from(mergeProposals)
    .where(eq(mergeProposals.state, "pending"))
    .all();
  if (!rows.length) return [];

  const ids = new Set<number>();
  for (const r of rows) {
    ids.add(r.winnerId);
    ids.add(r.loserId);
  }
  const items = db
    .select()
    .from(trackerItems)
    .where(inArray(trackerItems.id, [...ids]))
    .all();
  const byId = new Map(items.map((i) => [i.id, i]));

  const out: MergeProposalView[] = [];
  for (const r of rows) {
    const winner = byId.get(r.winnerId);
    const loser = byId.get(r.loserId);
    if (!winner || !loser || winner.deletedAt || loser.deletedAt) {
      // Mark stale outside list path — leave for respond/stale sweep
      continue;
    }
    out.push({
      id: r.id,
      winnerId: r.winnerId,
      loserId: r.loserId,
      origin: r.origin,
      conflicts: parseConflicts(r.conflictsJson),
      state: r.state,
      createdRev: r.createdRev,
      createdAt: r.createdAt,
      winner: briefItem(winner),
      loser: briefItem(loser),
    });
  }
  return out;
}

export type MergeRespondInput = {
  decision: "accept" | "reject";
  /** field → chosen value (winner | loser side, or absolute string for recipient) */
  choices?: Record<string, string | null>;
};

export type MergeRespondResult = {
  ok: boolean;
  state: string;
  rev: number;
  intoId?: number;
  error?: string;
};

function markProposal(
  id: string,
  state: "applied" | "rejected" | "stale",
): void {
  getDb()
    .update(mergeProposals)
    .set({ state, resolvedAt: new Date().toISOString() })
    .where(eq(mergeProposals.id, id))
    .run();
}

/**
 * Accept: apply conflict choices on winner, reassign loser's mails, soft-merge loser.
 * Reject: mark rejected only.
 */
export function respondMergeProposal(
  proposalId: string,
  input: MergeRespondInput,
): MergeRespondResult {
  const sqlite = getSqlite();
  const run = sqlite.transaction(() => {
    const db = getDb();
    const proposal = db
      .select()
      .from(mergeProposals)
      .where(eq(mergeProposals.id, proposalId))
      .get();
    if (!proposal) {
      return {
        ok: false,
        state: "missing",
        rev: getTrackerRevision(sqlite),
        error: t("tracker.error.mergeNotFound"),
      };
    }
    if (proposal.state !== "pending") {
      return {
        ok: false,
        state: proposal.state,
        rev: getTrackerRevision(sqlite),
        error: t("tracker.error.mergeNotPending"),
      };
    }

    const winner = db
      .select()
      .from(trackerItems)
      .where(eq(trackerItems.id, proposal.winnerId))
      .get();
    const loser = db
      .select()
      .from(trackerItems)
      .where(eq(trackerItems.id, proposal.loserId))
      .get();

    if (!winner || !loser || winner.deletedAt || loser.deletedAt) {
      markProposal(proposalId, "stale");
      const rev = bumpRevision(sqlite, "mutation", "global", "all");
      return {
        ok: false,
        state: "stale",
        rev,
        error: t("tracker.error.mergeStale"),
      };
    }

    if (input.decision === "reject") {
      markProposal(proposalId, "rejected");
      const rev = bumpRevision(sqlite, "mutation", "upsert", [
        winner.id,
        loser.id,
      ]);
      return { ok: true, state: "rejected", rev };
    }

    const conflicts = parseConflicts(proposal.conflictsJson);
    const choices = input.choices || {};

    // Require a choice for each conflict field
    for (const c of conflicts) {
      if (!(c.field in choices)) {
        return {
          ok: false,
          state: "pending",
          rev: getTrackerRevision(sqlite),
          error: t("tracker.error.mergeChoicesRequired"),
        };
      }
    }

    const now = new Date().toISOString();
    let nextRecipient = winner.selectedRecipient || winner.primaryTo;
    let nextUserState =
      winner.userState ||
      (winner.status === "inactive" ? "inactive" : "active");
    let notesJson = winner.notesJson;

    for (const c of conflicts) {
      const chosen = choices[c.field];
      if (c.field === "user_state") {
        nextUserState =
          chosen === "inactive" || chosen === "active"
            ? chosen
            : nextUserState;
      } else if (c.field === "selected_recipient") {
        nextRecipient = chosen;
        if (chosen) {
          notesJson = withSelectedRecipient(notesJson, chosen);
        }
      }
    }

    // No conflicts: keep winner fields; still merge.
    db.update(trackerItems)
      .set({
        selectedRecipient: nextRecipient,
        primaryTo: nextRecipient || winner.primaryTo,
        userState: nextUserState,
        status: nextUserState === "inactive" ? "inactive" : winner.status,
        notesJson,
        userVersion: (winner.userVersion || 1) + 1,
        updatedAt: now,
      })
      .where(eq(trackerItems.id, winner.id))
      .run();

    // Reassign mail assignments from loser → winner
    const loserAssign = db
      .select()
      .from(mailAssignments)
      .where(eq(mailAssignments.itemId, loser.id))
      .all();
    for (const a of loserAssign) {
      db.update(mailAssignments)
        .set({ itemId: winner.id, source: "merge" })
        .where(eq(mailAssignments.mailId, a.mailId))
        .run();
    }

    db.insert(itemLineage)
      .values({
        oldId: loser.id,
        newId: winner.id,
        kind: "merge",
        at: now,
      })
      .run();

    const rev = mergeItemInTx(sqlite, loser.id, winner.id, "mutation");
    markProposal(proposalId, "applied");

    return {
      ok: true,
      state: "applied",
      rev,
      intoId: winner.id,
    };
  });

  return run.immediate();
}

/** Emit merge_proposal events after twin detection (optional notify). */
export function notifyMergeProposalsCreated(
  proposals: { id: string; itemIds: number[] }[],
): void {
  const rev = getTrackerRevision();
  for (const p of proposals) {
    emitTrackerEvent({
      type: "merge_proposal",
      rev,
      proposalId: p.id,
      itemIds: p.itemIds,
    });
  }
}
