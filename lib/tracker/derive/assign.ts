/**
 * Rule-based mail → item assignment (before AI routing).
 */

import { and, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { getTrackerRevision } from "@/lib/db/revision";
import {
  mailAssignments,
  mailMessages,
  mailUnassigned,
  trackerItemMails,
  trackerItems,
} from "@/lib/db/schema";
import { emailDomain, parseEmailAddr } from "../identity";

export type AssignSource =
  | "thread"
  | "reply_header"
  | "research_contact"
  | "domain"
  | "ai"
  | "user"
  | "legacy";

export type AssignResult =
  | { kind: "assigned"; itemId: number; source: AssignSource }
  | { kind: "already"; itemId: number }
  | { kind: "none" };

function mailRole(mail: {
  folder: string;
  subject: string;
  bodyText: string;
}): string {
  if (mail.folder !== "SENT") return "inbound";
  const blob = `${mail.subject}\n${mail.bodyText}`.toLowerCase();
  if (
    /teşekkür|thank you for (your time|the update|letting)|appreciate the (update|opportunity)/.test(
      blob,
    )
  ) {
    return "thanks";
  }
  if (
    /follow[- ]?up|following up|checking in|hatırlat|tekrar yazıyorum/.test(blob)
  ) {
    return "followup";
  }
  return "outbound";
}

/** Dual-write assignment + legacy tracker_item_mails. */
export function writeAssignment(input: {
  mailId: number;
  itemId: number;
  source: AssignSource;
  confidence?: number | null;
  locked?: boolean;
  mail: {
    folder: string;
    subject: string;
    bodyText: string;
  };
}): void {
  const db = getDb();
  const rev = getTrackerRevision();
  const existing = db
    .select()
    .from(mailAssignments)
    .where(eq(mailAssignments.mailId, input.mailId))
    .get();

  if (existing?.locked) {
    // Locked user assignment — never overwrite.
    return;
  }

  if (existing) {
    db.update(mailAssignments)
      .set({
        itemId: input.itemId,
        source: input.source,
        confidence: input.confidence ?? null,
        locked: input.locked ? 1 : existing.locked,
        assignedRev: rev,
      })
      .where(eq(mailAssignments.mailId, input.mailId))
      .run();
  } else {
    db.insert(mailAssignments)
      .values({
        mailId: input.mailId,
        itemId: input.itemId,
        source: input.source,
        confidence: input.confidence ?? null,
        locked: input.locked ? 1 : 0,
        assignedRev: rev,
      })
      .run();
  }

  // Clear unassigned if present
  db.delete(mailUnassigned)
    .where(eq(mailUnassigned.mailId, input.mailId))
    .run();

  // Dual-write legacy junction
  const legacy = db
    .select()
    .from(trackerItemMails)
    .where(eq(trackerItemMails.mailId, input.mailId))
    .all();
  for (const link of legacy) {
    if (link.itemId !== input.itemId) {
      db.delete(trackerItemMails)
        .where(eq(trackerItemMails.id, link.id))
        .run();
    }
  }
  const keep = db
    .select()
    .from(trackerItemMails)
    .where(
      and(
        eq(trackerItemMails.itemId, input.itemId),
        eq(trackerItemMails.mailId, input.mailId),
      ),
    )
    .get();
  if (!keep) {
    db.insert(trackerItemMails)
      .values({
        itemId: input.itemId,
        mailId: input.mailId,
        role: mailRole(input.mail),
      })
      .run();
  }
}

export function markUnassigned(
  mailId: number,
  reason: "ai_unavailable" | "ambiguous" | "unmatched_outbound",
): void {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .select()
    .from(mailUnassigned)
    .where(eq(mailUnassigned.mailId, mailId))
    .get();
  if (existing) {
    db.update(mailUnassigned)
      .set({
        reason,
        attempts: existing.attempts + 1,
      })
      .where(eq(mailUnassigned.mailId, mailId))
      .run();
  } else {
    db.insert(mailUnassigned)
      .values({
        mailId,
        reason,
        since: now,
        attempts: 1,
      })
      .run();
  }
}

export function getAssignment(mailId: number): {
  itemId: number;
  source: string;
  locked: boolean;
} | null {
  const row = getDb()
    .select()
    .from(mailAssignments)
    .where(eq(mailAssignments.mailId, mailId))
    .get();
  if (!row) return null;
  return {
    itemId: row.itemId,
    source: row.source,
    locked: Boolean(row.locked),
  };
}

/** In-Reply-To / References → known assigned mail's item. */
export function findItemByReplyHeaders(mail: {
  id: number;
  inReplyTo: string | null;
  referencesHdr: string | null;
}): number | null {
  const refs: string[] = [];
  if (mail.inReplyTo) refs.push(mail.inReplyTo.trim());
  if (mail.referencesHdr) {
    for (const part of mail.referencesHdr.split(/\s+/)) {
      const t = part.trim();
      if (t) refs.push(t);
    }
  }
  if (!refs.length) return null;

  const db = getDb();
  // Match message_id against refs
  const candidates = db
    .select({
      id: mailMessages.id,
    })
    .from(mailMessages)
    .where(inArray(mailMessages.messageId, refs))
    .all();
  if (!candidates.length) return null;

  const assign = db
    .select()
    .from(mailAssignments)
    .where(
      inArray(
        mailAssignments.mailId,
        candidates.map((c) => c.id),
      ),
    )
    .get();
  return assign?.itemId ?? null;
}

/** Same thread_id already assigned → that item. */
export function findItemByThread(
  mail: { id: number; threadId: string | null },
): number | null {
  if (!mail.threadId) return null;
  const db = getDb();
  const sameThread = db
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(
      and(
        eq(mailMessages.threadId, mail.threadId),
        ne(mailMessages.id, mail.id),
      ),
    )
    .all()
    .map((r) => r.id);
  if (!sameThread.length) return null;

  const assign = db
    .select()
    .from(mailAssignments)
    .where(inArray(mailAssignments.mailId, sameThread))
    .get();
  if (assign) return assign.itemId;

  // Legacy fallback during dual-write period
  const legacy = db
    .select()
    .from(trackerItemMails)
    .where(inArray(trackerItemMails.mailId, sameThread))
    .get();
  return legacy?.itemId ?? null;
}

const FREEMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.de",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "protonmail.com",
  "gmx.de",
  "gmx.com",
  "web.de",
  "t-online.de",
]);

/** Unique non-freemail domain or primary_to / selected_recipient match. */
export function findItemByDomainOrContact(
  mail: {
    folder: string;
    fromAddr: string;
    toAddr: string;
  },
  userEmail: string,
): number | null {
  const db = getDb();
  let counterparty: string | null = null;
  if (mail.folder === "SENT") {
    counterparty = parseEmailAddr(mail.toAddr.split(",")[0] || "");
  } else {
    const from = parseEmailAddr(mail.fromAddr);
    if (from && from !== userEmail) counterparty = from;
  }
  if (!counterparty) return null;

  const live = db
    .select()
    .from(trackerItems)
    .all()
    .filter((i) => !i.deletedAt);

  const byEmail = live.filter((item) => {
    const emails = [item.primaryTo, item.selectedRecipient]
      .map((e) => parseEmailAddr(e))
      .filter(Boolean) as string[];
    return emails.some((e) => e === counterparty);
  });
  if (byEmail.length === 1) return byEmail[0].id;

  const domain = emailDomain(counterparty);
  if (!domain || FREEMAIL.has(domain)) return null;

  const hits = live.filter((item) => {
    const emails = [item.primaryTo, item.selectedRecipient]
      .map((e) => parseEmailAddr(e))
      .filter(Boolean) as string[];
    return emails.some((e) => emailDomain(e) === domain);
  });
  if (hits.length === 1) return hits[0].id;
  return null;
}

/**
 * Deterministic assignment chain (architecture §2.6.1).
 */
export function tryRuleBasedAssign(
  mail: typeof mailMessages.$inferSelect,
  userEmail: string,
): AssignResult {
  const already = getAssignment(mail.id);
  if (already) return { kind: "already", itemId: already.itemId };

  const byReply = findItemByReplyHeaders(mail);
  if (byReply != null) {
    writeAssignment({
      mailId: mail.id,
      itemId: byReply,
      source: "reply_header",
      confidence: 0.95,
      mail,
    });
    return { kind: "assigned", itemId: byReply, source: "reply_header" };
  }

  const byThread = findItemByThread(mail);
  if (byThread != null) {
    writeAssignment({
      mailId: mail.id,
      itemId: byThread,
      source: "thread",
      confidence: 0.9,
      mail,
    });
    return { kind: "assigned", itemId: byThread, source: "thread" };
  }

  const byDomain = findItemByDomainOrContact(mail, userEmail);
  if (byDomain != null) {
    writeAssignment({
      mailId: mail.id,
      itemId: byDomain,
      source: "domain",
      confidence: 0.7,
      mail,
    });
    return { kind: "assigned", itemId: byDomain, source: "domain" };
  }

  return { kind: "none" };
}
