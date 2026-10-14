/**
 * Build Gmail web URLs from IMAP X-GM-THRID / Message-ID.
 * Multiple distinct threads → one URL each (open in separate tabs).
 *
 * `/u/0` vs `/u/1` is browser-session order — not stable. Prefer `authuser=`
 * with the configured Gmail address so the right account opens.
 */

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
  const sorted = [...mails].sort((a, b) => a.dateIso.localeCompare(b.dateIso));
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const m of sorted) {
    if (m.threadId) {
      const key = `t:${m.threadId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(threadIdToGmailUrl(m.threadId, authEmail));
    } else if (m.messageId) {
      const key = `m:${m.messageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(messageIdToGmailUrl(m.messageId, authEmail));
    }
  }

  return urls;
}
