/**
 * Per-mail process events (architecture §2.6.8) — pure, no DB / LLM imports.
 *
 * Stage 3 (AI, wave 2) writes `mail_events`; until then (and for mails it has
 * not labelled) events fall back to `mail_intents` for inbound and a
 * structural per-conversation rule for outbound.
 */

import type { MailIntent } from "../mail-kind";

export const MAIL_EVENTS = [
  "application_sent",
  "follow_up_sent",
  "thanks_sent",
  "withdrawn",
  "ack",
  "auto_ack",
  "info_request",
  "interview_invite",
  "assessment",
  "rejection",
  "offer",
  "ooo",
  "action_required",
  "other",
] as const;

export type MailEvent = (typeof MAIL_EVENTS)[number];

export type MailEventSource = "ai" | "regex" | "header" | "rule";

/** Inbound events that only start / keep the silence clock. */
export const PASSIVE_INBOUND_EVENTS: ReadonlySet<MailEvent> = new Set([
  "ack",
  "auto_ack",
  "ooo",
  "other",
]);

/** Inbound events that put the ball in the user's court (needs_action). */
export const NEEDS_ACTION_EVENTS: ReadonlySet<MailEvent> = new Set([
  "action_required",
  "assessment",
]);

/** Inbound events that put the ball in the user's court (needs_reply). */
export const NEEDS_REPLY_EVENTS: ReadonlySet<MailEvent> = new Set([
  "interview_invite",
  "info_request",
  "offer",
]);

export function normalizeMailEvent(v: unknown): MailEvent | null {
  if (typeof v === "string" && (MAIL_EVENTS as readonly string[]).includes(v)) {
    return v as MailEvent;
  }
  return null;
}

/**
 * Legacy inbound intent → event. `null` = not part of the process
 * (non_job / bounce) and is left out of the timeline.
 */
export function eventFromIntent(intent: MailIntent): MailEvent | null {
  switch (intent) {
    case "human_reply":
      return "info_request";
    case "rejection":
      return "rejection";
    case "ack":
    case "optional_portal":
      return "ack";
    case "auto_ack":
      return "auto_ack";
    case "ooo":
      return "ooo";
    case "click_action":
      return "action_required";
    case "unknown":
      return "other";
    case "non_job":
    case "bounce":
      return null;
  }
}

export type EventTimelineEntry = {
  mailId: number;
  at: string;
  dir: "in" | "out";
  event: MailEvent;
  /** stored = mail_events row; intent = mail_intents fallback; structural = outbound rule */
  origin: "stored" | "intent" | "structural";
  waitingUntil?: string | null;
};

export type TimelineMail = {
  id: number;
  dir: "in" | "out";
  at: string;
  /** Stage 0 conversation key (falls back to the mail id when unknown). */
  conversationKey: string | null;
  subject?: string;
  bodyText?: string;
};

export type StoredMailEvent = {
  event: MailEvent;
  waitingUntil?: string | null;
};

export type FallbackIntent = {
  intent: MailIntent;
  waitingUntil?: string | null;
};

const THANKS_RE =
  /teşekkür|thank you for (your time|the update|letting|the feedback|your feedback)|appreciate the (update|opportunity|feedback)|vielen dank für (ihre|die|deine) (schnelle |freundliche |ausführliche )?(rückmeldung|antwort|zeit|feedback)/i;

export function looksLikeThanks(subject: string, body: string): boolean {
  return THANKS_RE.test(`${subject}\n${body}`);
}

/**
 * Outbound mail without a stored event, judged by its position in its
 * conversation (`prior` = earlier entries of the same conversation).
 */
export function structuralOutboundEvent(
  prior: EventTimelineEntry[],
  mail: { subject?: string; bodyText?: string },
): MailEvent {
  let lastOutIdx = -1;
  for (let i = prior.length - 1; i >= 0; i -= 1) {
    if (prior[i]!.dir === "out") {
      lastOutIdx = i;
      break;
    }
  }
  const inboundSince = prior
    .slice(lastOutIdx + 1)
    .filter((e) => e.dir === "in");
  const lastMeaningful = [...inboundSince]
    .reverse()
    .find((e) => !PASSIVE_INBOUND_EVENTS.has(e.event));
  if (lastMeaningful?.event === "rejection") return "thanks_sent";
  if (lastMeaningful) {
    return looksLikeThanks(mail.subject || "", mail.bodyText || "")
      ? "thanks_sent"
      : "other";
  }
  if (lastOutIdx >= 0) return "follow_up_sent";
  return inboundSince.length ? "other" : "application_sent";
}

/**
 * Chronological per-mail event timeline for one item.
 * Precedence: stored event (stage 3) → inbound intent fallback → outbound rule.
 */
export function buildEventTimeline(input: {
  mails: TimelineMail[];
  events: ReadonlyMap<number, StoredMailEvent>;
  intents: ReadonlyMap<number, FallbackIntent>;
}): EventTimelineEntry[] {
  const sorted = [...input.mails].sort(
    (a, b) => a.at.localeCompare(b.at) || a.id - b.id,
  );
  const byConversation = new Map<string, EventTimelineEntry[]>();
  const out: EventTimelineEntry[] = [];

  for (const mail of sorted) {
    const convKey = mail.conversationKey || `mail:${mail.id}`;
    const prior = byConversation.get(convKey) || [];
    let entry: EventTimelineEntry | null = null;

    const stored = input.events.get(mail.id);
    if (stored) {
      entry = {
        mailId: mail.id,
        at: mail.at,
        dir: mail.dir,
        event: stored.event,
        origin: "stored",
        waitingUntil: stored.waitingUntil ?? null,
      };
    } else if (mail.dir === "out") {
      entry = {
        mailId: mail.id,
        at: mail.at,
        dir: "out",
        event: structuralOutboundEvent(prior, mail),
        origin: "structural",
      };
    } else {
      const intent = input.intents.get(mail.id);
      const event = eventFromIntent(intent?.intent ?? "unknown");
      if (event) {
        entry = {
          mailId: mail.id,
          at: mail.at,
          dir: "in",
          event,
          origin: "intent",
          waitingUntil: intent?.waitingUntil ?? null,
        };
      }
    }

    if (!entry) continue;
    prior.push(entry);
    byConversation.set(convKey, prior);
    out.push(entry);
  }
  return out;
}

type CompactEntry = {
  m: number;
  t: string;
  d: "in" | "out";
  e: MailEvent;
  o?: EventTimelineEntry["origin"];
  w?: string | null;
};

export function serializeTimeline(timeline: EventTimelineEntry[]): string {
  const compact: CompactEntry[] = timeline.map((e) => ({
    m: e.mailId,
    t: e.at,
    d: e.dir,
    e: e.event,
    o: e.origin,
    ...(e.waitingUntil ? { w: e.waitingUntil } : {}),
  }));
  return JSON.stringify(compact);
}

export function parseTimeline(
  raw: string | null | undefined,
): EventTimelineEntry[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out: EventTimelineEntry[] = [];
    for (const item of parsed as CompactEntry[]) {
      const event = normalizeMailEvent(item?.e);
      if (!event || typeof item.t !== "string") continue;
      out.push({
        mailId: Number(item.m) || 0,
        at: item.t,
        dir: item.d === "out" ? "out" : "in",
        event,
        origin: item.o || "stored",
        waitingUntil: item.w ?? null,
      });
    }
    return out;
  } catch {
    return null;
  }
}
