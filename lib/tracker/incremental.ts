/**
 * Fast path after incremental IMAP: classify/link only newly inserted mails.
 * Full AI rebuild stays for hard sync / empty tracker / large influx.
 */

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  mailMessages,
  trackerItemMails,
  trackerItems,
} from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { getSettingsRow } from "@/lib/settings/service";
import {
  classifyMailSignals,
  flagsFromIntent,
} from "./agents/mail-signals";
import { throwIfSyncCanceled } from "./cancel";
import {
  isMeaningfulIntent,
  resolveMailIntent,
  type MailIntentMap,
} from "./mail-kind";
import type { MailBrief } from "./match";
import {
  emailDomain,
  normalizeCompanyKey,
  parseEmailAddr,
} from "./identity";
import { collapseInactiveActiveTwins } from "./inactive";
import { normalizeMailText } from "./signals";
import { resolveStatus } from "./status";
import type { SyncProgressFn } from "./types";
/** Above this, fall back to full rebuild (too many to patch safely). */
export const INCREMENTAL_PATCH_MAX = 25;

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

function findItemIdForMail(
  mail: typeof mailMessages.$inferSelect,
  userEmail: string,
): number | null {
  const db = getDb();

  if (mail.threadId) {
    const sameThread = db
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(eq(mailMessages.threadId, mail.threadId))
      .all()
      .map((r) => r.id)
      .filter((id) => id !== mail.id);
    if (sameThread.length) {
      const link = db
        .select()
        .from(trackerItemMails)
        .where(inArray(trackerItemMails.mailId, sameThread))
        .get();
      if (link) return link.itemId;
    }
  }

  const domain = counterpartyDomain(mail, userEmail);
  const items = db.select().from(trackerItems).all();
  // Prefer inactive twins first so paused apps don't sprout a second active row.
  const ordered = [
    ...items.filter((i) => i.status === "inactive"),
    ...items.filter((i) => i.status !== "inactive"),
  ];

  if (domain) {
    for (const item of ordered) {
      if (item.primaryTo) {
        const pd = emailDomain(parseEmailAddr(item.primaryTo));
        if (pd === domain) return item.id;
      }
      const companyKey = normalizeCompanyKey(item.company);
      if (companyKey && companyKey === normalizeCompanyKey(domain.split(".")[0] || "")) {
        return item.id;
      }
      const links = db
        .select()
        .from(trackerItemMails)
        .where(eq(trackerItemMails.itemId, item.id))
        .all();
      if (!links.length) continue;
      const linked = db
        .select()
        .from(mailMessages)
        .where(
          inArray(
            mailMessages.id,
            links.map((l) => l.mailId),
          ),
        )
        .all();
      for (const lm of linked) {
        if (counterpartyDomain(lm, userEmail) === domain) return item.id;
        if (emailDomain(parseEmailAddr(lm.fromAddr)) === domain) return item.id;
        if (
          lm.toAddr
            .split(",")
            .some((p) => emailDomain(parseEmailAddr(p)) === domain)
        ) {
          return item.id;
        }
      }
    }
  }
  return null;
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
    .from(trackerItemMails)
    .where(eq(trackerItemMails.itemId, itemId))
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

  // Keep post-follow-up cooldown
  let status = resolved.status;
  let waitingOn = resolved.waitingOn;
  let nextFollowUpAt = resolved.nextFollowUpAt;
  const oldCooldown = item.nextFollowUpAt
    ? Date.parse(item.nextFollowUpAt)
    : NaN;
  if (
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
    .from(trackerItemMails)
    .where(
      and(
        eq(trackerItemMails.itemId, itemId),
        eq(trackerItemMails.mailId, mail.id),
      ),
    )
    .get();
  if (existing) return false;
  db.insert(trackerItemMails)
    .values({
      itemId,
      mailId: mail.id,
      role: mailRole(mail),
    })
    .run();
  return true;
}

function createItemForMail(
  mail: typeof mailMessages.$inferSelect,
  userEmail: string,
): number {
  const db = getDb();
  const domain = counterpartyDomain(mail, userEmail);
  const company = domain
    ? companyFromDomain(domain)
    : mail.subject.replace(/^(re|aw|wg|fwd):\s*/i, "").slice(0, 80) ||
      t("tracker.unknownCompany");
  const primaryTo =
    mail.folder === "SENT"
      ? mail.toAddr.split(",")[0]?.trim() || null
      : parseEmailAddr(mail.fromAddr);
  const now = new Date().toISOString();
  const inserted = db
    .insert(trackerItems)
    .values({
      company,
      position: null,
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
        notes: "incremental create",
        lastMailIntent: "unknown",
      }),
      hasFollowUpDraft: 0,
      hasThanksDraft: 0,
      hasReplyDraft: 0,
      updatedAt: now,
      createdAt: now,
    })
    .returning({ id: trackerItems.id })
    .get();
  if (!inserted) throw new Error(t("tracker.error.createItemFailed"));
  linkMail(inserted.id, mail);
  return inserted.id;
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

  for (const mail of newMails) {
    throwIfSyncCanceled(signal);
    const intent = mailIntents.get(mail.id)?.intent;
    if (intent === "non_job") {
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
      .from(trackerItemMails)
      .where(eq(trackerItemMails.mailId, mail.id))
      .get();
    if (already) {
      touched.add(already.itemId);
      continue;
    }

    const itemId = findItemIdForMail(mail, userEmail);
    if (itemId) {
      if (linkMail(itemId, mail)) attached += 1;
      touched.add(itemId);
      const item = db
        .select()
        .from(trackerItems)
        .where(eq(trackerItems.id, itemId))
        .get();
      log?.(
        "ok",
        t("sync.incrementalAttached", {
          company: item?.company || `#${itemId}`,
          folder:
            mail.folder === "INBOX"
              ? t("mail.folder.inbox")
              : mail.folder === "SENT"
                ? t("mail.folder.sent")
                : mail.folder,
        }),
      );
      continue;
    }

    // Unmatched SENT without a thread/domain hit — skip creating orphans
    if (mail.folder === "SENT") {
      skipped += 1;
      log?.(
        "system",
        t("sync.incrementalSkippedUnmatched", {
          subject: mail.subject.slice(0, 60) || t("mail.noSubject"),
        }),
      );
      continue;
    }

    const newId = createItemForMail(mail, userEmail);
    created += 1;
    touched.add(newId);
    const item = db
      .select()
      .from(trackerItems)
      .where(eq(trackerItems.id, newId))
      .get();
    log?.(
      "ok",
      t("sync.incrementalCreated", {
        company: item?.company || `#${newId}`,
      }),
    );
  }

  for (const itemId of touched) {
    refreshItemStatus(itemId, mailIntents, followUpDays, userEmail);
  }

  const collapsed = collapseInactiveActiveTwins();
  if (collapsed > 0) {
    log?.(
      "system",
      t("sync.collapsedTwins", { count: collapsed }),
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
