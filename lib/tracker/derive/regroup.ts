/**
 * Explicit "AI yeniden grupla" path: stable-id diff + single transaction.
 * Normal sync must NOT call this — use derivePendingMails instead.
 */

import { eq } from "drizzle-orm";
import { getDb, getSqlite } from "@/lib/db/client";
import {
  mailAssignments,
  mailMessages,
  mailUnassigned,
  trackerItemMails,
  trackerItems,
} from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { getSettingsRow } from "@/lib/settings/service";
import { classifyMailSignals } from "../agents/mail-signals";
import { throwIfSyncCanceled } from "../cancel";
import { normalizeCompanyKey, parseEmailAddr } from "../identity";
import { matchMailsToGroups, type AiGroup, type MailBrief } from "../match";
import type { MailIntentMap } from "../mail-kind";
import { normalizeMailText } from "../signals";
import type { SyncProgressFn } from "../types";
import { listWorkspaceCandidates } from "../workspace-merge";
import { writeAssignment } from "./assign";
import { suggestTwinMerges } from "./merge-suggestions";
import { refreshItemFacts } from "./refresh-item";

export type RegroupPreview = {
  update: number;
  create: number;
  mergeOk: number;
  mergeNeedsDecision: number;
  untouched: number;
};

type WeightEdge = { groupIdx: number; itemId: number; weight: number };

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function threadsOfMails(
  mailIds: number[],
  mailById: Map<number, typeof mailMessages.$inferSelect>,
): Set<string> {
  const s = new Set<string>();
  for (const id of mailIds) {
    const t = mailById.get(id)?.threadId;
    if (t) s.add(t);
  }
  return s;
}

function scoreGroupItem(
  g: AiGroup,
  item: typeof trackerItems.$inferSelect,
  itemThreads: Set<string>,
  groupThreads: Set<string>,
): number {
  let w = 0;
  const origin =
    item.originResearchJobId || item.researchJobId || null;
  if (g.researchJobId && origin && g.researchJobId === origin) w += 1.0;
  w += jaccard(groupThreads, itemThreads);
  const gEmail = parseEmailAddr(
    // first outbound/inbound not available here — use company primary later
    null,
  );
  void gEmail;
  const itemEmail = parseEmailAddr(item.primaryTo || item.selectedRecipient);
  // Primary email overlap approximated via company key when emails unknown
  if (
    itemEmail &&
    g.company &&
    normalizeCompanyKey(item.company) === normalizeCompanyKey(g.company)
  ) {
    w += 0.15;
  }
  if (
    normalizeCompanyKey(item.company) === normalizeCompanyKey(g.company)
  ) {
    w += 0.2;
  }
  return w;
}

function greedyMatch(
  edges: WeightEdge[],
  threshold: number,
): Map<number, number> {
  // groupIdx → itemId
  const sorted = [...edges].sort((a, b) => b.weight - a.weight);
  const usedGroups = new Set<number>();
  const usedItems = new Set<number>();
  const match = new Map<number, number>();
  for (const e of sorted) {
    if (e.weight < threshold) break;
    if (usedGroups.has(e.groupIdx) || usedItems.has(e.itemId)) continue;
    usedGroups.add(e.groupIdx);
    usedItems.add(e.itemId);
    match.set(e.groupIdx, e.itemId);
  }
  return match;
}

/**
 * Build a dry-run preview of regroup without writing.
 */
export function previewRegroup(
  groups: AiGroup[],
  items: (typeof trackerItems.$inferSelect)[],
  mailById: Map<number, typeof mailMessages.$inferSelect>,
): { preview: RegroupPreview; match: Map<number, number> } {
  const live = items.filter((i) => !i.deletedAt);
  const itemMailIds = new Map<number, number[]>();
  const db = getDb();
  for (const item of live) {
    const assigns = db
      .select()
      .from(mailAssignments)
      .where(eq(mailAssignments.itemId, item.id))
      .all();
    let ids = assigns.map((a) => a.mailId);
    if (!ids.length) {
      ids = db
        .select()
        .from(trackerItemMails)
        .where(eq(trackerItemMails.itemId, item.id))
        .all()
        .map((l) => l.mailId);
    }
    itemMailIds.set(item.id, ids);
  }

  const edges: WeightEdge[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const gThreads = threadsOfMails(g.mailIds, mailById);
    for (const item of live) {
      const iThreads = threadsOfMails(
        itemMailIds.get(item.id) || [],
        mailById,
      );
      const weight = scoreGroupItem(g, item, iThreads, gThreads);
      if (weight > 0) edges.push({ groupIdx: gi, itemId: item.id, weight });
    }
  }

  const match = greedyMatch(edges, 0.35);
  const matchedItems = new Set(match.values());
  const matchedGroups = new Set(match.keys());

  // Detect merge candidates: two items scoring high on same group
  let mergeNeedsDecision = 0;
  let mergeOk = 0;
  // Simplified: count unmatched inactive/active pairs as twin suggestions later

  return {
    preview: {
      update: matchedGroups.size,
      create: groups.length - matchedGroups.size,
      mergeOk,
      mergeNeedsDecision,
      untouched: live.length - matchedItems.size,
    },
    match,
  };
}

/**
 * Apply regroup in a single transaction (assignments + in-place item updates).
 * Does not DELETE-all items — ids stay stable when matched.
 */
export async function regroupTrackerItems(opts?: {
  onProgress?: SyncProgressFn;
  signal?: AbortSignal;
  /** When true, only return preview stats without writing (scaffold). */
  dryRun?: boolean;
}): Promise<{ itemCount: number; preview: RegroupPreview }> {
  const log = opts?.onProgress;
  const signal = opts?.signal;
  const settings = getSettingsRow();
  const followUpDays = settings?.followUpDays ?? 5;

  throwIfSyncCanceled(signal);
  const allMails = getDb().select().from(mailMessages).all();
  const mailById = new Map(allMails.map((m) => [m.id, m]));
  const briefs: MailBrief[] = allMails.map((m) => ({
    id: m.id,
    folder: m.folder,
    fromAddr: m.fromAddr,
    toAddr: m.toAddr,
    subject: m.subject,
    dateIso: m.internalDate || m.dateIso,
    snippet: m.snippet,
    threadId: m.threadId,
    bodyPreview: normalizeMailText(m.bodyText || m.snippet || "").slice(0, 600),
  }));

  const searches = listWorkspaceCandidates();
  log?.(
    "think",
    t("sync.briefsSummary", {
      mails: briefs.length,
      searches: searches.length,
    }),
  );

  const mailIntents: MailIntentMap = await classifyMailSignals(briefs, {
    onProgress: log,
    signal,
  });
  throwIfSyncCanceled(signal);

  const groups = await matchMailsToGroups(briefs, searches, {
    onProgress: log,
    signal,
    mailIntents,
  });
  throwIfSyncCanceled(signal);

  const db = getDb();
  const prev = db.select().from(trackerItems).all();
  const { preview, match } = previewRegroup(groups, prev, mailById);

  log?.(
    "think",
    t("sync.writingGroups", { count: groups.length }),
  );

  if (opts?.dryRun) {
    return {
      itemCount: prev.filter((p) => !p.deletedAt).length,
      preview,
    };
  }

  const now = new Date().toISOString();

  getSqlite().transaction(() => {
    const usedItemIds = new Set<number>();

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const matchedId = match.get(gi);
      let itemId: number;

      if (matchedId != null) {
        itemId = matchedId;
        usedItemIds.add(itemId);
        const old = prev.find((p) => p.id === itemId);
        db.update(trackerItems)
          .set({
            company: g.company,
            position: g.position,
            researchJobId: g.researchJobId || old?.researchJobId || null,
            originResearchJobId:
              g.researchJobId ||
              old?.originResearchJobId ||
              old?.researchJobId ||
              null,
            aiStatus: g.status,
            // Preserve user columns
            userState: old?.userState || "active",
            selectedRecipient: old?.selectedRecipient || null,
            updatedAt: now,
          })
          .where(eq(trackerItems.id, itemId))
          .run();
      } else {
        const inserted = db
          .insert(trackerItems)
          .values({
            company: g.company,
            position: g.position,
            status: g.status || "in_progress",
            aiStatus: g.status || "in_progress",
            sentiment: g.sentiment,
            waitingOn: g.waitingOn,
            followUpCount: g.followUpCountHint || 0,
            researchJobId: g.researchJobId,
            originResearchJobId: g.researchJobId,
            notesJson: JSON.stringify({ notes: g.notes }),
            userState: "active",
            hasFollowUpDraft: 0,
            hasThanksDraft: 0,
            hasReplyDraft: 0,
            ignored: 0,
            updatedAt: now,
            createdAt: now,
          })
          .returning({ id: trackerItems.id })
          .get();
        if (!inserted) continue;
        itemId = inserted.id;
        usedItemIds.add(itemId);
      }

      // Locked assignments stay; replace unlocked for this group's mails
      for (const mailId of g.mailIds) {
        const mail = mailById.get(mailId);
        if (!mail) continue;
        const existing = db
          .select()
          .from(mailAssignments)
          .where(eq(mailAssignments.mailId, mailId))
          .get();
        if (existing?.locked) continue;
        writeAssignment({
          mailId,
          itemId,
          source: "ai",
          confidence: 0.85,
          mail,
        });
        db.delete(mailUnassigned)
          .where(eq(mailUnassigned.mailId, mailId))
          .run();
      }
    }

    // Soft-preserve unmatched items that have user traces
    for (const old of prev) {
      if (old.deletedAt || usedItemIds.has(old.id)) continue;
      const hasUser =
        old.userState === "inactive" ||
        Boolean(old.selectedRecipient) ||
        old.status === "inactive";
      if (hasUser) continue; // keep as-is
      // Research-only empty ghosts: soft-delete
      if (
        (old.status === "ready_to_send" || old.aiStatus === "ready_to_send") &&
        !old.workspaceFolder
      ) {
        const hasMail = db
          .select()
          .from(mailAssignments)
          .where(eq(mailAssignments.itemId, old.id))
          .get();
        if (!hasMail) {
          db.update(trackerItems)
            .set({
              deletedAt: now,
              deletedReason: "orphan",
              updatedAt: now,
            })
            .where(eq(trackerItems.id, old.id))
            .run();
        }
      }
    }

    // Merge proposals for twins (K3) — never silent merge
    suggestTwinMerges();
  })();

  // Refresh facts outside tx (needs intent map; pure writes per item)
  const liveIds = db
    .select({ id: trackerItems.id })
    .from(trackerItems)
    .all()
    .filter((r) => {
      const full = db
        .select()
        .from(trackerItems)
        .where(eq(trackerItems.id, r.id))
        .get();
      return full && !full.deletedAt;
    })
    .map((r) => r.id);

  for (const id of liveIds) {
    refreshItemFacts(id, mailIntents, followUpDays);
  }

  const itemCount = db
    .select()
    .from(trackerItems)
    .all()
    .filter((i) => !i.deletedAt).length;

  return { itemCount, preview };
}
