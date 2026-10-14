import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { trackerItemMails, trackerItems } from "@/lib/db/schema";
import { companyKey } from "./signals";
import {
  getWorkspaceCandidate,
  type WorkspaceCandidate,
} from "./workspace-merge";
import { emitTrackerLive } from "./live";

export type LightMergeResult = {
  ok: boolean;
  action: "inserted" | "updated" | "linked" | "skipped";
  searchJobId: string;
  itemId?: number;
  reason?: string;
};

function itemHasMails(itemId: number): boolean {
  const db = getDb();
  const row = db
    .select({ id: trackerItemMails.id })
    .from(trackerItemMails)
    .where(eq(trackerItemMails.itemId, itemId))
    .get();
  return Boolean(row);
}

function insertReadyToSend(c: WorkspaceCandidate): number {
  const db = getDb();
  const now = new Date().toISOString();
  const inserted = db
    .insert(trackerItems)
    .values({
      company: c.company,
      position: null,
      status: "ready_to_send",
      sentiment: null,
      waitingOn: null,
      followUpCount: 0,
      lastOutboundAt: null,
      lastInboundAt: null,
      nextFollowUpAt: null,
      ignored: 0,
      workspaceFolder: c.workspaceFolder,
      searchJobId: c.searchJobId,
      primaryTo: c.primaryTo,
      notesJson: JSON.stringify({
        notes: "workspace search only (light merge)",
        waitingUntil: null,
      }),
      hasFollowUpDraft: 0,
      hasThanksDraft: 0,
      hasReplyDraft: 0,
      updatedAt: now,
      createdAt: now,
    })
    .returning({ id: trackerItems.id })
    .get();
  if (!inserted) throw new Error("tracker insert failed");
  return inserted.id;
}

function patchSearchMeta(
  itemId: number,
  c: WorkspaceCandidate,
  opts?: { overwriteSearchJobId?: boolean },
) {
  const db = getDb();
  const row = db
    .select()
    .from(trackerItems)
    .where(eq(trackerItems.id, itemId))
    .get();
  if (!row) return;

  const nextJobId =
    opts?.overwriteSearchJobId || !row.searchJobId
      ? c.searchJobId
      : row.searchJobId;

  db.update(trackerItems)
    .set({
      company: c.company || row.company,
      workspaceFolder: c.workspaceFolder || row.workspaceFolder,
      searchJobId: nextJobId,
      primaryTo: c.primaryTo || row.primaryTo,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(trackerItems.id, itemId))
    .run();
}

/**
 * No IMAP/AI/wipe. Merges a finished search workspace candidate into the current tracker.
 * Gmail sync remains the heavy path that updates mail statuses.
 */
export function mergeSearchJobIntoTracker(
  searchJobId: string,
): LightMergeResult {
  const c = getWorkspaceCandidate(searchJobId);
  if (!c) {
    return {
      ok: false,
      action: "skipped",
      searchJobId,
      reason: "no workspace candidate (done + folder)",
    };
  }

  const db = getDb();
  const all = db.select().from(trackerItems).all();
  const byJob = all.find((r) => r.searchJobId === searchJobId);

  if (byJob) {
    patchSearchMeta(byJob.id, c, { overwriteSearchJobId: true });
    const result: LightMergeResult = {
      ok: true,
      action: "updated",
      searchJobId,
      itemId: byJob.id,
    };
    emitTrackerLive({
      type: "search_merged",
      searchJobId,
      action: result.action,
      itemId: result.itemId,
    });
    return result;
  }

  const ck = companyKey(c.company);
  const sameCompany = all.filter((r) => companyKey(r.company) === ck);
  const mailFlags = new Map(
    sameCompany.map((r) => [r.id, itemHasMails(r.id)]),
  );
  const companyHasMails = sameCompany.some((r) => mailFlags.get(r.id));
  const companyHasOutboundThread = sameCompany.some(
    (r) =>
      mailFlags.get(r.id) &&
      r.status !== "ready_to_send" &&
      r.status !== "closed" &&
      r.status !== "inactive",
  );

  // Fresh search draft + existing thread → separate ready_to_send (same rule as full rebuild)
  if (c.hasEmailDraft && companyHasOutboundThread) {
    const itemId = insertReadyToSend(c);
    for (const r of sameCompany) {
      if (mailFlags.get(r.id)) {
        patchSearchMeta(r.id, c, { overwriteSearchJobId: true });
      }
    }
    const result: LightMergeResult = {
      ok: true,
      action: "inserted",
      searchJobId,
      itemId,
    };
    emitTrackerLive({
      type: "search_merged",
      searchJobId,
      action: result.action,
      itemId,
    });
    return result;
  }

  if (companyHasMails) {
    // Attach to rows without search meta; otherwise update folder on same-company rows
    const bare = sameCompany.filter((r) => !r.searchJobId);
    const targets = bare.length ? bare : sameCompany;
    for (const r of targets) {
      patchSearchMeta(r.id, c, { overwriteSearchJobId: !r.searchJobId });
    }
    const result: LightMergeResult = {
      ok: true,
      action: "linked",
      searchJobId,
      itemId: sameCompany[0]?.id,
    };
    emitTrackerLive({
      type: "search_merged",
      searchJobId,
      action: result.action,
      itemId: result.itemId,
    });
    return result;
  }

  const itemId = insertReadyToSend(c);
  const result: LightMergeResult = {
    ok: true,
    action: "inserted",
    searchJobId,
    itemId,
  };
  emitTrackerLive({
    type: "search_merged",
    searchJobId,
    action: result.action,
    itemId,
  });
  return result;
}
