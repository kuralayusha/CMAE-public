/**
 * Resolve reply target from the latest linked mail (SENT or INBOX).
 * Follow-ups / replies / thanks should continue that thread.
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mailAssignments, mailMessages } from "@/lib/db/schema";
import { getSettingsRow } from "@/lib/settings/service";

export type ThreadReplyTarget = {
  to: string;
  inReplyTo: string | null;
  references: string | null;
  /** Subject of the mail we are answering (for Re: prefix) */
  anchorSubject: string;
  anchorFolder: "INBOX" | "SENT" | string;
  anchorDateIso: string;
};

function firstEmail(list: string): string | null {
  const m = String(list || "").match(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  );
  return m?.[0]?.toLowerCase() || null;
}

function userEmails(): Set<string> {
  const s = getSettingsRow();
  const set = new Set<string>();
  const e = firstEmail(s?.gmailAddress || "");
  if (e) set.add(e);
  return set;
}

function normalizeMessageId(id: string): string {
  const t = id.trim();
  if (!t) return t;
  if (t.startsWith("<") && t.endsWith(">")) return t;
  return `<${t}>`;
}

/** Use conversation subject with Re: so Gmail threads the draft. */
export function replySubject(
  draftSubject: string,
  anchorSubject: string | null | undefined,
): string {
  const draft = (draftSubject || "").trim();
  if (/^(re|aw|wg|sv)\s*:/i.test(draft)) return draft;
  const anchor = (anchorSubject || "").trim();
  if (!anchor) return draft;
  const root = anchor.replace(/^(re|aw|wg|sv|fwd|fw)\s*:\s*/gi, "").trim();
  if (!root) return draft;
  return `Re: ${root}`;
}

/**
 * Latest linked mail wins. INBOX → reply to From; SENT → reply to To
 * (skipping our own addresses).
 */
export function resolveThreadReplyTarget(
  itemId: number,
): ThreadReplyTarget | null {
  const db = getDb();
  const links = db
    .select()
    .from(mailAssignments)
    .where(eq(mailAssignments.itemId, itemId))
    .all();
  if (!links.length) return null;

  const mails = [];
  for (const link of links) {
    const m = db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.id, link.mailId))
      .get();
    if (m) mails.push(m);
  }
  if (!mails.length) return null;

  const last = [...mails].sort((a, b) => a.dateIso.localeCompare(b.dateIso)).at(
    -1,
  );
  if (!last) return null;

  const mine = userEmails();
  let to: string | null = null;
  if (last.folder === "INBOX") {
    to = firstEmail(last.fromAddr);
  } else {
    const parts = last.toAddr.split(",").map((p) => p.trim()).filter(Boolean);
    for (const p of parts) {
      const e = firstEmail(p);
      if (e && !mine.has(e)) {
        to = e;
        break;
      }
    }
    if (!to) to = firstEmail(last.toAddr);
  }

  if (!to) return null;

  const mid = last.messageId?.trim()
    ? normalizeMessageId(last.messageId)
    : null;

  return {
    to,
    inReplyTo: mid,
    references: mid,
    anchorSubject: last.subject || "",
    anchorFolder: last.folder,
    anchorDateIso: last.dateIso,
  };
}
