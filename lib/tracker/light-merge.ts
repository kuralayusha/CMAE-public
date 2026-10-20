import { eq } from "drizzle-orm";
import { getDb, getSqlite } from "@/lib/db/client";
import { bumpTrackerRevision } from "@/lib/db/revision";
import { trackerItemMails, trackerItems } from "@/lib/db/schema";
import {
  loadRecipientsForItem,
  parseSelectedRecipient,
  resolveEffectiveRecipient,
} from "./recipients";
import { companyKey } from "./signals";
import {
  getWorkspaceCandidate,
  type WorkspaceCandidate,
} from "./workspace-merge";
import { emitTrackerLive } from "./live";

export type LightMergeResult = {
  ok: boolean;
  action: "inserted" | "updated" | "linked" | "skipped";
  researchJobId: string;
  itemId?: number;
  reason?: string;
};

function afterResearchWrite(
  result: LightMergeResult,
): LightMergeResult {
  if (result.ok && result.action !== "skipped") {
    bumpTrackerRevision(
      "research",
      "upsert",
      result.itemId != null ? [result.itemId] : "all",
    );
  }
  return result;
}

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
  // Idempotent: unique origin_research_job_id among live rows
  const existing = db
    .select()
    .from(trackerItems)
    .all()
    .find(
      (r) =>
        !r.deletedAt &&
        (r.originResearchJobId === c.researchJobId ||
          r.researchJobId === c.researchJobId),
    );
  if (existing) return existing.id;

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
      researchJobId: c.researchJobId,
      originResearchJobId: c.researchJobId,
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

function patchResearchMeta(
  itemId: number,
  c: WorkspaceCandidate,
  opts?: { overwriteResearchJobId?: boolean },
) {
  const db = getDb();
  const row = db
    .select()
    .from(trackerItems)
    .where(eq(trackerItems.id, itemId))
    .get();
  if (!row) return;

  const nextJobId =
    opts?.overwriteResearchJobId || !row.researchJobId
      ? c.researchJobId
      : row.researchJobId;

  const nextFolder = c.workspaceFolder || row.workspaceFolder;
  const recipients = loadRecipientsForItem({ workspaceFolder: nextFolder });
  const selected = parseSelectedRecipient(row.notesJson);
  const primaryTo = resolveEffectiveRecipient({
    selected,
    recommended: recipients.recommended || c.primaryTo,
    candidates: recipients.candidates,
    fallback: c.primaryTo || row.primaryTo,
  });

  db.update(trackerItems)
    .set({
      company: c.company || row.company,
      workspaceFolder: nextFolder,
      researchJobId: nextJobId,
      primaryTo,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(trackerItems.id, itemId))
    .run();
}

/**
 * No IMAP/AI/wipe. Merges a finished search workspace candidate into the current tracker.
 * Gmail sync remains the heavy path that updates mail statuses.
 */
export function mergeResearchJobIntoTracker(
  researchJobId: string,
): LightMergeResult {
  const c = getWorkspaceCandidate(researchJobId);
  if (!c) {
    return {
      ok: false,
      action: "skipped",
      researchJobId,
      reason: "no workspace candidate (done + folder)",
    };
  }

  const sqlite = getSqlite();
  const result = sqlite
    .transaction((): LightMergeResult => {
      const db = getDb();
      const all = db
        .select()
        .from(trackerItems)
        .all()
        .filter((r) => !r.deletedAt);
      const byJob = all.find(
        (r) =>
          r.researchJobId === researchJobId ||
          r.originResearchJobId === researchJobId,
      );

      if (byJob) {
        patchResearchMeta(byJob.id, c, { overwriteResearchJobId: true });
        return {
          ok: true,
          action: "updated",
          researchJobId,
          itemId: byJob.id,
        };
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

      if (c.hasEmailDraft && companyHasOutboundThread) {
        const itemId = insertReadyToSend(c);
        for (const r of sameCompany) {
          if (mailFlags.get(r.id)) {
            patchResearchMeta(r.id, c, { overwriteResearchJobId: true });
          }
        }
        return {
          ok: true,
          action: "inserted",
          researchJobId,
          itemId,
        };
      }

      if (companyHasMails) {
        const bare = sameCompany.filter((r) => !r.researchJobId);
        const targets = bare.length ? bare : sameCompany;
        for (const r of targets) {
          patchResearchMeta(r.id, c, {
            overwriteResearchJobId: !r.researchJobId,
          });
        }
        return {
          ok: true,
          action: "linked",
          researchJobId,
          itemId: sameCompany[0]?.id,
        };
      }

      const itemId = insertReadyToSend(c);
      return {
        ok: true,
        action: "inserted",
        researchJobId,
        itemId,
      };
    })
    .immediate();

  if (result.ok && result.action !== "skipped") {
    emitTrackerLive({
      type: "research_merged",
      researchJobId,
      action: result.action,
      itemId: result.itemId,
    });
  }
  return afterResearchWrite(result);
}
