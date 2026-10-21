/**
 * Fast path after incremental IMAP: classify/link only newly inserted mails.
 * Full AI rebuild stays for hard sync / empty tracker / large influx.
 */

import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  mailAssignments,
  mailMessages,
  trackerItems,
} from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { getSettingsRow } from "@/lib/settings/service";
import {
  classifyMailSignals,
  flagsFromIntent,
} from "./agents/mail-signals";
import {
  routeIncrementalMails,
  type ExistingItemBrief,
} from "./agents/incremental-route";
import { throwIfSyncCanceled } from "./cancel";
import {
  isMeaningfulIntent,
  resolveMailIntent,
  type MailIntentMap,
} from "./mail-kind";
import type { MailBrief } from "./match";
import {
  emailDomain,
  parseEmailAddr,
} from "./identity";
import { markUnassigned } from "./derive/assign";
import { suggestTwinMerges } from "./derive/merge-suggestions";
import {
  parsePendingGmailDraft,
  shouldClearPendingGmailDraft,
} from "./pending-draft";
import { isNonJobMail, normalizeMailText } from "./signals";
import { resolveStatus } from "./status";
import type { SyncProgressFn } from "./types";
/**
 * @deprecated Faz 4: normal sync always uses derivePendingMails (chunks of 200).
 * Kept so older imports compile; run.ts no longer uses this threshold.
 */
export const INCREMENTAL_PATCH_MAX = Number.POSITIVE_INFINITY;

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

function companyFromDomain(domain: string): string {
  const base = domain.split(".")[0] || domain;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function counterpartyDomain(
  mail: {
    folder: string;
    fromAddr: string;
    toAddr: string;
  },
  userEmail: string,
): string | null {
  if (mail.folder === "SENT") {
    for (const part of mail.toAddr.split(",")) {
      const d = emailDomain(parseEmailAddr(part));
      if (d) return d;
    }
    return null;
  }
  const from = parseEmailAddr(mail.fromAddr);
  if (from && from !== userEmail) return emailDomain(from);
  return null;
}

function mailRole(
  mail: { folder: string; subject: string; bodyText: string },
): string {
  if (mail.folder !== "SENT") return "inbound";
  if (detectThanks([mail])) return "thanks";
  if (countFollowUps([mail]) > 0) return "followup";
  return "outbound";
}

function toBrief(m: typeof mailMessages.$inferSelect): MailBrief {
  return {
    id: m.id,
    folder: m.folder,
    fromAddr: m.fromAddr,
    toAddr: m.toAddr,
    subject: m.subject,
    dateIso: m.dateIso,
    snippet: m.snippet,
    threadId: m.threadId,
    bodyPreview: normalizeMailText(m.bodyText || m.snippet || "").slice(0, 600),
  };
}

/** Same Gmail thread already linked → safe auto-attach (no AI). */
function findItemIdByThread(
  mail: typeof mailMessages.$inferSelect,
): number | null {
  if (!mail.threadId) return null;
  const db = getDb();
  const sameThread = db
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(eq(mailMessages.threadId, mail.threadId))
    .all()
    .map((r) => r.id)
    .filter((id) => id !== mail.id);
  if (!sameThread.length) return null;
  const link = db
    .select()
    .from(mailAssignments)
    .where(inArray(mailAssignments.mailId, sameThread))
    .get();
  return link?.itemId ?? null;
}

function existingItemBriefs(): ExistingItemBrief[] {
  const db = getDb();
  const items = db.select().from(trackerItems).all();
  return items.map((item) => {
    const links = db
      .select()
      .from(mailAssignments)
      .where(eq(mailAssignments.itemId, item.id))
      .all();
    let lastSubject: string | null = null;
    if (links.length) {
      const linked = db
        .select()
        .from(mailMessages)
        .where(
          inArray(
            mailMessages.id,
            links.map((l) => l.mailId),
          ),
        )
        .all()
        .sort((a, b) => a.dateIso.localeCompare(b.dateIso));
      lastSubject = linked.at(-1)?.subject ?? null;
    }
    return {
      id: item.id,
      company: item.company,
      position: item.position,
      status: item.status,
      primaryTo: item.primaryTo,
      lastSubject,
    };
  });
}

function refreshItemStatus(
  itemId: number,
  mailIntents: MailIntentMap,
  followUpDays: number,
  userEmail: string,
): void {
  const db = getDb();
  const item = db
    .select()
    .from(trackerItems)
    .where(eq(trackerItems.id, itemId))
    .get();
  if (!item) return;
  if (item.status === "inactive") return;

  const links = db
    .select()
    .from(mailAssignments)
    .where(eq(mailAssignments.itemId, itemId))
    .all();
  const linkedMails = links.length
    ? db
        .select()
        .from(mailMessages)
        .where(
          inArray(
            mailMessages.id,
            links.map((l) => l.mailId),
          ),
        )
        .all()
    : [];

  const outbounds = linkedMails.filter((m) => m.folder === "SENT");
  const inbounds = linkedMails.filter((m) => m.folder === "INBOX");
  const lastOutboundAt =
    outbounds.map((m) => m.dateIso).sort().at(-1) ?? null;
  const lastInboundAt =
    inbounds.map((m) => m.dateIso).sort().at(-1) ?? null;

  const intentFor = (
    mailId: number,
    subject: string,
    body: string,
    from: string,
    to: string,
  ) =>
    resolveMailIntent({
      mailId,
      subject,
      body,
      fromAddr: from,
      toAddr: to,
      folder: "INBOX",
      ai: mailIntents.get(mailId)?.intent,
    });

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

  const followUpCount = Math.max(
    item.followUpCount,
    countFollowUps(linkedMails),
  );
  const isThanksSent = detectThanks(linkedMails);
  const oooUntil = lastFlags.isOoo
    ? mailIntents.get(lastInboundMail!.id)?.waitingUntil || null
    : null;

  let notesObj: Record<string, unknown> = {};
  try {
    notesObj = item.notesJson
      ? (JSON.parse(item.notesJson) as Record<string, unknown>)
      : {};
  } catch {
    notesObj = {};
  }

  const resolved = resolveStatus({
    aiStatus: item.status,
    sentiment: item.sentiment,
    waitingOn: item.waitingOn,
    waitingUntil: oooUntil || (notesObj.waitingUntil as string | null) || null,
    lastOutboundAt,
    lastInboundAt,
    lastMeaningfulInboundAt,
    followUpCount,
    followUpDays,
    hasOutbound: outbounds.length > 0,
    hasInbound: inbounds.length > 0,
    isThanksSent,
    fromResearchOnly: linkedMails.length === 0 && Boolean(item.researchJobId),
    lastInboundSubject: lastInboundMail?.subject ?? null,
    lastInboundBody,
    lastInboundFrom: lastInboundMail?.fromAddr ?? null,
    isAutoReply: lastFlags.isAutoReply,
    isAckOnly: lastFlags.isAckOnly,
    isClickAction: lastFlags.isClickAction,
    isRejected: lastFlags.isRejected || meaningfulIntent === "rejection",
  });

  const pending = parsePendingGmailDraft(item.notesJson);
  const pendingCleared = shouldClearPendingGmailDraft(pending, lastOutboundAt);

  // Legacy cooldown only when not waiting on user to send a Gmail draft
  let status = resolved.status;
  let waitingOn = resolved.waitingOn;
  let nextFollowUpAt = resolved.nextFollowUpAt;
  const oldCooldown = item.nextFollowUpAt
    ? Date.parse(item.nextFollowUpAt)
    : NaN;
  if (
    !pending &&
    Number.isFinite(oldCooldown) &&
    oldCooldown > Date.now() &&
    status === "follow_up_due"
  ) {
    status = "in_progress";
    waitingOn = "them";
    nextFollowUpAt = item.nextFollowUpAt;
  }

  const primaryTo =
    item.primaryTo ||
    outbounds
      .map((m) => m.toAddr.split(",")[0]?.trim())
      .find(Boolean) ||
    inbounds
      .map((m) => m.fromAddr.split(",")[0]?.trim())
      .find((a) => a && parseEmailAddr(a) !== userEmail) ||
    null;

  notesObj = {
    ...notesObj,
    waitingUntil: resolved.waitingUntil,
    isAutoReply: lastFlags.isAutoReply,
    isAckOnly: lastFlags.isAckOnly,
    isClickAction: lastFlags.isClickAction,
    lastMailIntent: lastIntent,
  };
  if (pendingCleared) {
    delete notesObj.pendingGmailDraft;
  }

  db.update(trackerItems)
    .set({
      status,
      sentiment: resolved.sentiment,
      waitingOn,
      followUpCount,
      lastOutboundAt,
      lastInboundAt,
      nextFollowUpAt,
      ignored: resolved.ignored ? 1 : 0,
      primaryTo,
      notesJson: JSON.stringify(notesObj),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(trackerItems.id, itemId))
    .run();
}

function linkMail(itemId: number, mail: typeof mailMessages.$inferSelect): boolean {
  const db = getDb();
  const existing = db
    .select()
    .from(mailAssignments)
    .where(eq(mailAssignments.mailId, mail.id))
    .get();
  if (existing) {
    if (existing.itemId === itemId) return false;
    db.update(mailAssignments)
      .set({ itemId, source: "legacy" })
      .where(eq(mailAssignments.mailId, mail.id))
      .run();
    return true;
  }
  db.insert(mailAssignments)
    .values({
      itemId,
      mailId: mail.id,
      source: "legacy",
      locked: 0,
      assignedRev: 0,
    })
    .run();
  void mailRole(mail);
  return true;
}

function createItemForMail(
  mail: typeof mailMessages.$inferSelect,
  userEmail: string,
  opts?: { company?: string | null; position?: string | null },
): number {
  const db = getDb();
  const domain = counterpartyDomain(mail, userEmail);
  const company =
    (opts?.company || "").trim() ||
    (domain ? companyFromDomain(domain) : "") ||
    mail.subject.replace(/^(re|aw|wg|fwd):\s*/i, "").slice(0, 80) ||
    t("tracker.unknownCompany");
  const position = (opts?.position || "").trim() || null;
  const primaryTo =
    mail.folder === "SENT"
      ? mail.toAddr.split(",")[0]?.trim() || null
      : parseEmailAddr(mail.fromAddr);
  const now = new Date().toISOString();
  const inserted = db
    .insert(trackerItems)
    .values({
      company,
      position,
      status: "in_progress",
      sentiment: null,
      waitingOn: mail.folder === "SENT" ? "them" : "us",
      followUpCount: 0,
      lastOutboundAt: mail.folder === "SENT" ? mail.dateIso : null,
      lastInboundAt: mail.folder === "INBOX" ? mail.dateIso : null,
      nextFollowUpAt: null,
      ignored: 0,
      workspaceFolder: null,
      researchJobId: null,
      primaryTo,
      notesJson: JSON.stringify({
        notes: "incremental create (AI)",
        lastMailIntent: "unknown",
      }),
      updatedAt: now,
      createdAt: now,
    })
    .returning({ id: trackerItems.id })
    .get();
  if (!inserted) throw new Error(t("tracker.error.createItemFailed"));
  linkMail(inserted.id, mail);
  return inserted.id;
}

function folderLabel(folder: string): string {
  if (folder === "INBOX") return t("mail.folder.inbox");
  if (folder === "SENT") return t("mail.folder.sent");
  return folder;
}

/**
 * Patch tracker with newly inserted mail ids only (no full regroup).
 */
export async function patchTrackerWithNewMails(
  insertedIds: number[],
  opts?: { onProgress?: SyncProgressFn; signal?: AbortSignal },
): Promise<{ itemCount: number; attached: number; created: number; skipped: number }> {
  const log = opts?.onProgress;
  const signal = opts?.signal;
  const db = getDb();
  const settings = getSettingsRow();
  const followUpDays = settings?.followUpDays ?? 5;
  const userEmail = (settings?.gmailAddress || "").toLowerCase();

  const existingCount = db.select().from(trackerItems).all().length;
  if (!insertedIds.length) {
    log?.("ok", t("sync.incrementalNoNew"));
    return {
      itemCount: existingCount,
      attached: 0,
      created: 0,
      skipped: 0,
    };
  }

  throwIfSyncCanceled(signal);
  const newMails = db
    .select()
    .from(mailMessages)
    .where(inArray(mailMessages.id, insertedIds))
    .all();

  log?.(
    "think",
    t("sync.incrementalStart", { count: newMails.length }),
  );

  const inboxBriefs = newMails
    .filter((m) => m.folder === "INBOX")
    .map(toBrief);
  const mailIntents: MailIntentMap =
    inboxBriefs.length > 0
      ? await classifyMailSignals(inboxBriefs, { onProgress: log, signal })
      : new Map();
  throwIfSyncCanceled(signal);

  let attached = 0;
  let created = 0;
  let skipped = 0;
  const touched = new Set<number>();
  /** Unmatched INBOX mails that need AI job/group routing */
  const needsRoute: (typeof mailMessages.$inferSelect)[] = [];

  for (const mail of newMails) {
    throwIfSyncCanceled(signal);
    const brief = toBrief(mail);
    const intent = mailIntents.get(mail.id)?.intent;
    const noise =
      intent === "non_job" ||
      (mail.folder === "INBOX" && isNonJobMail(brief));

    if (noise) {
      skipped += 1;
      log?.(
        "system",
        t("sync.incrementalSkippedNoise", {
          subject: mail.subject.slice(0, 60) || t("mail.noSubject"),
        }),
      );
      continue;
    }

    const already = db
      .select()
      .from(mailAssignments)
      .where(eq(mailAssignments.mailId, mail.id))
      .get();
    if (already) {
      touched.add(already.itemId);
      continue;
    }

    // Same thread already tracked — safe without AI
    const threadItemId = findItemIdByThread(mail);
    if (threadItemId) {
      if (linkMail(threadItemId, mail)) attached += 1;
      touched.add(threadItemId);
      const item = db
        .select()
        .from(trackerItems)
        .where(eq(trackerItems.id, threadItemId))
        .get();
      log?.(
        "ok",
        t("sync.incrementalAttached", {
          company: item?.company || `#${threadItemId}`,
          folder: folderLabel(mail.folder),
        }),
      );
      continue;
    }

    // Unmatched SENT — never invent a row from outbound alone; queue for review
    if (mail.folder === "SENT") {
      skipped += 1;
      markUnassigned(mail.id, "unmatched_outbound");
      log?.(
        "system",
        t("sync.incrementalQueuedUnmatched", {
          subject: mail.subject.slice(0, 60) || t("mail.noSubject"),
        }),
      );
      continue;
    }

    needsRoute.push(mail);
  }

  if (needsRoute.length) {
    throwIfSyncCanceled(signal);
    const decisions = await routeIncrementalMails(
      needsRoute.map(toBrief),
      existingItemBriefs(),
      { onProgress: log, signal },
    );
    throwIfSyncCanceled(signal);

    for (const mail of needsRoute) {
      throwIfSyncCanceled(signal);
      const decision = decisions.get(mail.id);
      const action = decision?.action ?? "skip";

      if (action === "attach" && decision?.itemId != null) {
        const itemId = decision.itemId;
        const item = db
          .select()
          .from(trackerItems)
          .where(eq(trackerItems.id, itemId))
          .get();
        if (!item) {
          skipped += 1;
          log?.(
            "system",
            t("sync.incrementalSkippedNoise", {
              subject: mail.subject.slice(0, 60) || t("mail.noSubject"),
            }),
          );
          continue;
        }
        if (linkMail(itemId, mail)) attached += 1;
        touched.add(itemId);
        log?.(
          "ok",
          t("sync.incrementalAttached", {
            company: item.company,
            folder: folderLabel(mail.folder),
          }),
        );
        continue;
      }

      if (action === "create" && decision?.company) {
        const newId = createItemForMail(mail, userEmail, {
          company: decision.company,
          position: decision.position,
        });
        created += 1;
        touched.add(newId);
        log?.(
          "ok",
          t("sync.incrementalCreated", {
            company: decision.company,
          }),
        );
        continue;
      }

      skipped += 1;
      log?.(
        "system",
        t("sync.incrementalSkippedNoise", {
          subject: mail.subject.slice(0, 60) || t("mail.noSubject"),
        }),
      );
    }
  }

  for (const itemId of touched) {
    refreshItemStatus(itemId, mailIntents, followUpDays, userEmail);
  }

  // K3: never auto-collapse twins — emit merge_proposals only.
  const proposals = suggestTwinMerges();
  if (proposals > 0) {
    log?.(
      "system",
      t("sync.collapsedTwins", { count: proposals }),
    );
  }

  const itemCount = db.select().from(trackerItems).all().length;
  log?.(
    "ok",
    t("sync.incrementalDone", {
      attached,
      created,
      skipped,
      rows: itemCount,
    }),
  );
  return { itemCount, attached, created, skipped };
}
