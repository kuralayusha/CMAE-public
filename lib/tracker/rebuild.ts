import path from "path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  mailMessages,
  trackerItemMails,
  trackerItems,
} from "@/lib/db/schema";
import { getSettingsRow } from "@/lib/settings/service";
import { getWorkspaceRoot } from "@/lib/search/workspace";
import {
  classifyMailSignals,
  flagsFromIntent,
} from "./agents/mail-signals";
import {
  isMeaningfulIntent,
  resolveMailIntent,
  type MailIntentMap,
} from "./mail-kind";
import { matchMailsToGroups, type MailBrief } from "./match";
import { extractPrimaryEmailFromWorkspace } from "./parse-mail-md";
import { normalizeMailText } from "./signals";
import { resolveStatus } from "./status";
import { throwIfSyncCanceled } from "./cancel";
import type { SyncProgressFn } from "./types";
import { listWorkspaceCandidates } from "./workspace-merge";

function countFollowUps(
  mails: { folder: string; subject: string; bodyText: string }[],
): number {
  let n = 0;
  for (const m of mails) {
    if (m.folder !== "SENT") continue;
    const blob = `${m.subject}\n${m.bodyText}`.toLowerCase();
    if (
      /follow[- ]?up|following up|checking in|hatırlat|tekrar yazıyorum|üzerinden.*geçti/.test(
        blob,
      )
    ) {
      n += 1;
    }
  }
  return n;
}

function detectThanks(
  mails: { folder: string; subject: string; bodyText: string }[],
): boolean {
  return mails.some((m) => {
    if (m.folder !== "SENT") return false;
    const blob = `${m.subject}\n${m.bodyText}`.toLowerCase();
    return /teşekkür|thank you for (your time|the update|letting)|appreciate the (update|opportunity)/.test(
      blob,
    );
  });
}

/**
 * Wipe tracker_items and rebuild from stored mails + workspace searches + AI.
 */
export async function rebuildTrackerItems(opts?: {
  onProgress?: SyncProgressFn;
  signal?: AbortSignal;
}): Promise<{ itemCount: number }> {
  const log = opts?.onProgress;
  const signal = opts?.signal;
  const db = getDb();
  const settings = getSettingsRow();
  const followUpDays = settings?.followUpDays ?? 5;
  const userEmail = (
    settings?.gmailAddress ||
    ""
  ).toLowerCase();

  throwIfSyncCanceled(signal);
  const allMails = db.select().from(mailMessages).all();
  const briefs: MailBrief[] = allMails.map((m) => ({
    id: m.id,
    folder: m.folder,
    fromAddr: m.fromAddr,
    toAddr: m.toAddr,
    subject: m.subject,
    dateIso: m.dateIso,
    snippet: m.snippet,
    threadId: m.threadId,
    bodyPreview: normalizeMailText(m.bodyText || m.snippet || "").slice(0, 600),
  }));

  const searches = listWorkspaceCandidates();
  log?.(
    "think",
    `${briefs.length} mails · ${searches.length} workspace candidates…`,
  );

  // Pass 1: language-agnostic per-mail intent (AI + regex)
  const mailIntents: MailIntentMap = await classifyMailSignals(briefs, {
    onProgress: log,
    signal,
  });
  throwIfSyncCanceled(signal);

  // Pass 2: group + status (sees intent hints)
  const groups = await matchMailsToGroups(briefs, searches, {
    onProgress: log,
    signal,
    mailIntents,
  });
  throwIfSyncCanceled(signal);
  log?.("think", `${groups.length} groups → writing tracker rows…`);

  // Preserve draft flags + inactive keyed by searchJobId / company
  const prev = db.select().from(trackerItems).all();
  const prevByJob = new Map(
    prev.filter((p) => p.searchJobId).map((p) => [p.searchJobId!, p]),
  );
  const prevByCompany = new Map(prev.map((p) => [p.company.toLowerCase(), p]));
  const inactivePrev = prev.filter((p) => p.status === "inactive");
  const rematchedInactive = new Set<number>();

  db.delete(trackerItemMails).run();
  db.delete(trackerItems).run();

  const mailById = new Map(allMails.map((m) => [m.id, m]));
  const root = getWorkspaceRoot();
  let itemCount = 0;

  for (const g of groups) {
    const linkedMails = g.mailIds
      .map((id) => mailById.get(id))
      .filter((m): m is NonNullable<typeof m> => Boolean(m));

    const search = searches.find((s) => s.searchJobId === g.searchJobId);
    let workspaceFolder = search?.workspaceFolder ?? null;
    let folderPath = search?.folderPath ?? null;
    if (!folderPath && workspaceFolder) {
      folderPath = path.join(root, workspaceFolder);
    }

    // try attach search by company name if AI omitted id
    if (!search) {
      const byName = searches.find(
        (s) => s.company.toLowerCase() === g.company.toLowerCase(),
      );
      if (byName) {
        g.searchJobId = byName.searchJobId;
        workspaceFolder = byName.workspaceFolder;
        folderPath = byName.folderPath;
      }
    }

    const outbounds = linkedMails.filter((m) => m.folder === "SENT");
    const inbounds = linkedMails.filter((m) => m.folder === "INBOX");
    const lastOutboundAt =
      outbounds.map((m) => m.dateIso).sort().at(-1) ?? null;
    const lastInboundAt =
      inbounds.map((m) => m.dateIso).sort().at(-1) ?? null;

    const intentFor = (mailId: number, subject: string, body: string, from: string, to: string) =>
      resolveMailIntent({
        mailId,
        subject,
        body,
        fromAddr: from,
        toAddr: to,
        folder: "INBOX",
        ai: mailIntents.get(mailId)?.intent,
      });

    // Only human_reply / rejection reset the silence clock (any language via AI)
    const meaningfulInbounds = inbounds.filter((m) => {
      const body = normalizeMailText(m.bodyText || m.snippet || "");
      const intent = intentFor(m.id, m.subject, body, m.fromAddr, m.toAddr);
      return isMeaningfulIntent(intent);
    });
    const lastMeaningfulInboundAt =
      meaningfulInbounds.map((m) => m.dateIso).sort().at(-1) ?? null;
    const lastMeaningfulMail = [...meaningfulInbounds]
      .sort((a, b) => a.dateIso.localeCompare(b.dateIso))
      .at(-1);

    const lastInboundMail = [...inbounds]
      .sort((a, b) => a.dateIso.localeCompare(b.dateIso))
      .at(-1);

    const lastInboundBody = lastInboundMail
      ? normalizeMailText(
          lastInboundMail.bodyText || lastInboundMail.snippet || "",
        )
      : null;
    const lastIntent = lastInboundMail
      ? intentFor(
          lastInboundMail.id,
          lastInboundMail.subject,
          lastInboundBody || "",
          lastInboundMail.fromAddr,
          lastInboundMail.toAddr,
        )
      : "unknown";
    const lastFlags = flagsFromIntent(lastIntent);
    const meaningfulIntent = lastMeaningfulMail
      ? intentFor(
          lastMeaningfulMail.id,
          lastMeaningfulMail.subject,
          normalizeMailText(
            lastMeaningfulMail.bodyText || lastMeaningfulMail.snippet || "",
          ),
          lastMeaningfulMail.fromAddr,
          lastMeaningfulMail.toAddr,
        )
      : "unknown";

    const old =
      (g.searchJobId && prevByJob.get(g.searchJobId)) ||
      prevByCompany.get(g.company.toLowerCase());

    const followUpCount = Math.max(
      g.followUpCountHint,
      countFollowUps(linkedMails),
      old?.followUpCount ?? 0,
    );
    const isThanksSent = g.isThanksSent || detectThanks(linkedMails);
    const fromSearchOnly = linkedMails.length === 0 && Boolean(g.searchJobId);

    const oooUntil =
      lastFlags.isOoo
        ? mailIntents.get(lastInboundMail!.id)?.waitingUntil || g.waitingUntil
        : g.waitingUntil;

    const resolved = resolveStatus({
      aiStatus: g.status,
      sentiment: g.sentiment,
      waitingOn: g.waitingOn,
      waitingUntil: oooUntil,
      lastOutboundAt,
      lastInboundAt,
      lastMeaningfulInboundAt,
      followUpCount,
      followUpDays,
      hasOutbound: outbounds.length > 0,
      hasInbound: inbounds.length > 0,
      isThanksSent,
      fromSearchOnly,
      lastInboundSubject: lastInboundMail?.subject ?? null,
      lastInboundBody,
      lastInboundFrom: lastInboundMail?.fromAddr ?? null,
      isAutoReply: g.isAutoReply || lastFlags.isAutoReply,
      isAckOnly: g.isAckOnly || lastFlags.isAckOnly,
      isClickAction: g.isClickAction || lastFlags.isClickAction,
      isRejected:
        lastFlags.isRejected || meaningfulIntent === "rejection",
    });

    const primaryTo =
      search?.primaryTo ||
      extractPrimaryEmailFromWorkspace(folderPath || "") ||
      outbounds
        .map((m) => m.toAddr.split(",")[0]?.trim())
        .find(Boolean) ||
      inbounds
        .map((m) => m.fromAddr.split(",")[0]?.trim())
        .find((a) => a && a.toLowerCase() !== userEmail) ||
      null;

    // Inactive survives sync: keep frozen until user activates
    const stayInactive = old?.status === "inactive";
    if (stayInactive && old) rematchedInactive.add(old.id);

    let status = stayInactive ? "inactive" : resolved.status;
    let waitingOn = stayInactive ? null : resolved.waitingOn;
    let nextFollowUpAt = stayInactive ? null : resolved.nextFollowUpAt;
    let ignored = stayInactive ? 0 : resolved.ignored ? 1 : 0;

    // Keep post-follow-up cooldown if draft was created before SENT sync
    const oldCooldown = old?.nextFollowUpAt
      ? Date.parse(old.nextFollowUpAt)
      : NaN;
    if (
      !stayInactive &&
      Number.isFinite(oldCooldown) &&
      oldCooldown > Date.now() &&
      status === "follow_up_due"
    ) {
      status = "in_progress";
      waitingOn = "them";
      nextFollowUpAt = old!.nextFollowUpAt;
      ignored = 0;
    }

    let notesObj: Record<string, unknown> = {
      notes: g.notes,
      waitingUntil: stayInactive ? null : resolved.waitingUntil,
      isAutoReply: g.isAutoReply || lastFlags.isAutoReply,
      isAckOnly: g.isAckOnly || lastFlags.isAckOnly,
      isClickAction: g.isClickAction || lastFlags.isClickAction,
      lastMailIntent: lastIntent,
    };
    if (stayInactive && old?.notesJson) {
      try {
        const prevNotes = JSON.parse(old.notesJson) as Record<string, unknown>;
        if (prevNotes.statusBeforeInactive) {
          notesObj.statusBeforeInactive = prevNotes.statusBeforeInactive;
        }
      } catch {
        /* ignore */
      }
    }

    const inserted = db
      .insert(trackerItems)
      .values({
        company: g.company,
        position: g.position,
        status,
        sentiment: stayInactive ? null : resolved.sentiment,
        waitingOn,
        followUpCount,
        lastOutboundAt,
        lastInboundAt,
        nextFollowUpAt,
        ignored,
        workspaceFolder,
        searchJobId: g.searchJobId,
        primaryTo,
        notesJson: JSON.stringify(notesObj),
        hasFollowUpDraft: old?.hasFollowUpDraft ?? 0,
        hasThanksDraft: old?.hasThanksDraft ?? 0,
        hasReplyDraft: old?.hasReplyDraft ?? 0,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      })
      .returning({ id: trackerItems.id })
      .get();

    if (!inserted) continue;
    itemCount += 1;

    for (const m of linkedMails) {
      const role =
        m.folder === "SENT"
          ? detectThanks([m])
            ? "thanks"
            : countFollowUps([m]) > 0
              ? "followup"
              : "outbound"
          : "inbound";
      db.insert(trackerItemMails)
        .values({ itemId: inserted.id, mailId: m.id, role })
        .run();
    }
  }

  // Re-insert inactive rows that had no matching group this rebuild
  // (so sync cannot drop a user-paused company).
  for (const old of inactivePrev) {
    if (rematchedInactive.has(old.id)) continue;
    db.insert(trackerItems)
      .values({
        company: old.company,
        position: old.position,
        status: "inactive",
        sentiment: null,
        waitingOn: null,
        followUpCount: old.followUpCount,
        lastOutboundAt: old.lastOutboundAt,
        lastInboundAt: old.lastInboundAt,
        nextFollowUpAt: null,
        ignored: 0,
        workspaceFolder: old.workspaceFolder,
        searchJobId: old.searchJobId,
        primaryTo: old.primaryTo,
        notesJson: old.notesJson,
        hasFollowUpDraft: old.hasFollowUpDraft,
        hasThanksDraft: old.hasThanksDraft,
        hasReplyDraft: old.hasReplyDraft,
        updatedAt: new Date().toISOString(),
        createdAt: old.createdAt,
      })
      .run();
    itemCount += 1;
  }

  // Drop empty ready_to_send without draft? Keep all search candidates with drafts or folders.
  // Remove orphan ready_to_send with no workspace and no mails (shouldn't happen).
  const leftovers = db.select().from(trackerItems).all();
  for (const row of leftovers) {
    if (
      row.status === "ready_to_send" &&
      !row.workspaceFolder &&
      !row.searchJobId
    ) {
      db.delete(trackerItemMails).where(eq(trackerItemMails.itemId, row.id)).run();
      db.delete(trackerItems).where(eq(trackerItems.id, row.id)).run();
      itemCount -= 1;
    }
  }

  return { itemCount };
}
