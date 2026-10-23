/**
 * Build Gmail web URLs from IMAP X-GM-THRID / Message-ID.
 * Multiple distinct threads → one URL each (open in separate tabs).
 *
 * `/u/0` vs `/u/1` is browser-session order — not stable. Prefer `authuser=`
 * with the configured Gmail address so the right account opens.
 */

import { repairCollapsedQuotedPrintable } from "./mail-text";
import type { GmailThreadPreview } from "./types";

export type ThreadMailSource = {
  threadId: string | null;
  messageId: string;
  dateIso: string;
  subject?: string;
  fromAddr?: string;
  toAddr?: string;
  folder?: string;
  snippet?: string;
};

/** Stable id shared by the picker, prepare, and Gmail draft threading. */
export function threadKeyOf(mail: {
  threadId: string | null;
  messageId: string;
}): string {
  const threadId = mail.threadId?.trim();
  if (threadId) return `t:${threadId}`;
  return `m:${mail.messageId.trim()}`;
}

function gmailBase(authEmail?: string | null): string {
  const email = authEmail?.trim();
  if (email) {
    return `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}`;
  }
  return "https://mail.google.com/mail/u/0";
}

export function threadIdToGmailUrl(
  threadId: string,
  authEmail?: string | null,
): string {
  const trimmed = threadId.trim();
  let hex: string;
  if (/^[0-9]+$/.test(trimmed)) {
    hex = BigInt(trimmed).toString(16);
  } else {
    hex = trimmed.replace(/^0x/i, "").toLowerCase();
  }
  return `${gmailBase(authEmail)}#all/${hex}`;
}

export function messageIdToGmailUrl(
  messageId: string,
  authEmail?: string | null,
): string {
  const id = messageId.replace(/^<|>$/g, "").trim();
  return `${gmailBase(authEmail)}#search/rfc822msgid:${encodeURIComponent(id)}`;
}

export function buildGmailThreadUrls(
  mails: { threadId: string | null; messageId: string; dateIso: string }[],
  authEmail?: string | null,
): string[] {
  return buildGmailThreadPreviews(mails, authEmail).map((t) => t.url);
}

function firstEmail(list: string): string | null {
  const m = String(list || "").match(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  );
  return m?.[0]?.toLowerCase() || null;
}

function partyLabel(addr: string): string {
  const first = String(addr || "")
    .split(",")[0]
    ?.trim();
  if (!first) return "";
  const named = first.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (named) {
    const name = named[1].replace(/^["']|["']$/g, "").trim();
    if (name) return name;
    return named[2].trim();
  }
  return first;
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  uuml: "ü",
  Uuml: "Ü",
  auml: "ä",
  Auml: "Ä",
  ouml: "ö",
  Ouml: "Ö",
  szlig: "ß",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bdquo: "„",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  laquo: "«",
  raquo: "»",
  euro: "€",
  bull: "•",
  middot: "·",
  zwnj: "",
  zwj: "",
  shy: "",
};

function decodeEntities(raw: string): string {
  return raw.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code)) return all;
      try {
        return String.fromCodePoint(code);
      } catch {
        return all;
      }
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? all;
  });
}

function cleanMailText(raw: string): string {
  const stripped = String(raw || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/<[a-zA-Z!][^>\n]{0,160}$/g, " ");
  return decodeEntities(repairCollapsedQuotedPrintable(stripped))
    .replace(/[\u00ad\u200b\u200c\u200d\ufeff\uFFFD]/g, "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
}

function rootSubject(subject: string): string {
  return cleanMailText(subject)
    .replace(/^(?:(?:re|aw|wg|sv|fwd|fw)\s*:\s*)+/gi, "")
    .trim();
}

/** Split on sentence ends, but not on dates like "24. September". */
function openingSentences(text: string, maxSentences: number): string[] {
  const parts = text.split(/(?<=[^\d][.!?])\s+(?=\p{Lu})/u);
  return parts.map((part) => part.trim()).filter(Boolean).slice(0, maxSentences);
}

/** Opening of a message: a couple of sentences, quotes trimmed off. */
export function mailOpeningPreview(
  raw: string,
  maxSentences = 2,
  maxChars = 220,
): string {
  let text = cleanMailText(raw);
  if (!text) return "";
  const quoteAt = text.search(
    /\bOn .{8,120} wrote:|-----Original Message-----|_{5,}|From:\s+\S+.{0,40}Sent:/i,
  );
  if (quoteAt > 40) text = text.slice(0, quoteAt).trim();
  const sentences = openingSentences(text, maxSentences);
  let out = "";
  for (const piece of sentences) {
    const next = out ? `${out} ${piece}` : piece;
    if (out && next.length > maxChars) break;
    out = next;
  }
  if (!out) out = text;
  const truncated = out.length > maxChars;
  if (truncated) {
    let cut = out.slice(0, maxChars);
    const space = cut.lastIndexOf(" ");
    if (space > maxChars * 0.6) cut = cut.slice(0, space);
    out = cut.trimEnd().replace(/[,:;]+$/, "");
  }
  const withEntity = out;
  out = out.replace(/&(#x?[0-9a-f]{0,6}|[a-z]{0,12})?$/i, "").trimEnd();
  if ((truncated || out !== withEntity) && out && !/[.!?…]$/.test(out)) {
    out = `${out}…`;
  }
  return out;
}

function otherParty(
  mails: ThreadMailSource[],
  ownEmail: string | null,
): string {
  const own = ownEmail?.trim().toLowerCase() || "";
  const inbound = [...mails].reverse().find((m) => m.folder === "INBOX");
  if (inbound?.fromAddr) return partyLabel(inbound.fromAddr);
  const outbound = [...mails].reverse().find((m) => m.folder !== "INBOX");
  if (outbound?.toAddr) {
    for (const part of outbound.toAddr.split(",")) {
      const email = firstEmail(part);
      if (email && email !== own) return partyLabel(part);
    }
    return partyLabel(outbound.toAddr);
  }
  return partyLabel(mails.at(-1)?.fromAddr || "");
}

/**
 * One card per Gmail thread, newest activity first.
 * Subject is the thread title; from is the other person; preview is the
 * opening of the latest message.
 */
export function buildGmailThreadPreviews(
  mails: ThreadMailSource[],
  authEmail?: string | null,
  ownEmail?: string | null,
): GmailThreadPreview[] {
  const groups = new Map<string, ThreadMailSource[]>();
  for (const mail of mails) {
    if (!mail.threadId?.trim() && !mail.messageId?.trim()) continue;
    const key = threadKeyOf(mail);
    const list = groups.get(key) || [];
    list.push(mail);
    groups.set(key, list);
  }

  const previews: GmailThreadPreview[] = [];
  for (const [key, group] of groups) {
    const sorted = [...group].sort((a, b) =>
      a.dateIso.localeCompare(b.dateIso),
    );
    const latest = sorted.at(-1);
    if (!latest) continue;
    let subject = "";
    for (const mail of sorted) {
      const root = rootSubject(mail.subject || "");
      if (root) {
        subject = root;
        break;
      }
    }
    const url = latest.threadId?.trim()
      ? threadIdToGmailUrl(latest.threadId, authEmail)
      : messageIdToGmailUrl(latest.messageId, authEmail);
    previews.push({
      key,
      url,
      subject,
      from: otherParty(sorted, ownEmail ?? authEmail ?? null),
      preview: mailOpeningPreview(latest.snippet || ""),
      dateIso: latest.dateIso,
    });
  }

  previews.sort((a, b) => b.dateIso.localeCompare(a.dateIso));
  return previews;
}
