/**
 * Fill missing scheduledAt on interview / assessment events from mail bodies
 * (German/English date patterns via parseReturnDate). Pure; refresh persists.
 */

import { parseReturnDate } from "../signals";
import type { MailEvent } from "./events";
import type { StoredMailEvent } from "./events";

const INTERVIEW_CTX =
  /interview|gespr[aä]ch|termin|vorstellungs|kennengelernt|meeting|call\b|teams|zoom/i;

const ASSESSMENT_CTX =
  /assessment|aufgabe|coding.?challenge|test.?task|hackerrank|codility|deadline|frist|abgabe/i;

export type SchedulableMail = {
  id: number;
  subject: string;
  bodyText: string;
  snippet: string;
  dateIso: string;
};

/**
 * Extract YYYY-MM-DD for interview/assessment when the event has no scheduledAt.
 * Returns null when no trustworthy date is found.
 */
export function inferScheduledAt(input: {
  event: MailEvent;
  subject: string;
  body: string;
  /** Mail date — prefer dates on/after this day (not ancient stamps in signatures). */
  mailAt?: string;
}): string | null {
  const { event, subject, body, mailAt } = input;
  const blob = `${subject}\n${body}`;
  const allow =
    event === "interview_invite" ||
    event === "assessment" ||
    ((event === "other" || event === "ack") &&
      (INTERVIEW_CTX.test(blob) || ASSESSMENT_CTX.test(blob)));
  if (!allow) return null;

  const day = parseReturnDate(blob);
  if (!day) return null;

  // Prefer dates on or after the mail's calendar day (ignore old footer dates).
  if (mailAt) {
    const mailDay = mailAt.slice(0, 10);
    if (mailDay && day < mailDay) return null;
  }
  return day;
}

/**
 * Enrich stored events map in place: missing scheduledAt filled from mail text.
 * Returns mailIds that were updated (for DB persist).
 */
export function backfillScheduledAt(
  events: Map<number, StoredMailEvent>,
  mails: SchedulableMail[],
): number[] {
  const byId = new Map(mails.map((m) => [m.id, m]));
  const updated: number[] = [];

  // First pass: interview_invite / assessment
  for (const [mailId, stored] of events) {
    if (stored.scheduledAt) continue;
    if (stored.event !== "interview_invite" && stored.event !== "assessment") {
      continue;
    }
    const mail = byId.get(mailId);
    if (!mail) continue;
    const day = inferScheduledAt({
      event: stored.event,
      subject: mail.subject || "",
      body: mail.bodyText || mail.snippet || "",
      mailAt: mail.dateIso,
    });
    if (!day) continue;
    events.set(mailId, { ...stored, scheduledAt: day });
    updated.push(mailId);
  }

  // Propagate invite date onto later confirmation other/ack in the same item
  // that still lack scheduledAt (so fold keeps the day even if invite row is odd).
  let inviteDay: string | null = null;
  const chronological = [...events.entries()].sort((a, b) => {
    const ma = byId.get(a[0])?.dateIso || "";
    const mb = byId.get(b[0])?.dateIso || "";
    return ma.localeCompare(mb) || a[0] - b[0];
  });
  for (const [mailId, stored] of chronological) {
    if (stored.event === "interview_invite" && stored.scheduledAt) {
      inviteDay = stored.scheduledAt;
    }
    if (
      inviteDay &&
      !stored.scheduledAt &&
      (stored.event === "other" || stored.event === "ack")
    ) {
      const mail = byId.get(mailId);
      const blob = `${mail?.subject || ""}\n${mail?.bodyText || mail?.snippet || ""}`;
      if (INTERVIEW_CTX.test(blob) || stored.event === "ack") {
        // Prefer date in this mail; else inherit invite day
        const own = mail
          ? inferScheduledAt({
              event: stored.event,
              subject: mail.subject || "",
              body: mail.bodyText || mail.snippet || "",
              mailAt: mail.dateIso,
            })
          : null;
        events.set(mailId, { ...stored, scheduledAt: own || inviteDay });
        updated.push(mailId);
      }
    }
  }

  return [...new Set(updated)];
}
