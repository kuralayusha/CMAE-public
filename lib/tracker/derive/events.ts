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
  /** mail_events.source for stored entries. */
  source?: MailEventSource;
  waitingUntil?: string | null;
  /** AI confidence 0–1 when known (stored AI events). */
  confidence?: number | null;
  /** Normalized position label for multi-role rows (optional). */
  pos?: string | null;
  /** Interview / meeting day YYYY-MM-DD when known. */
  scheduledAt?: string | null;
};

/** AI rejection below this confidence counts as unverified in the UI. */
export const LOW_CONFIDENCE = 0.6;

/** Same order as foldTimeline: time, inbound before outbound, mailId. */
export function compareTimelineEntries(
  a: EventTimelineEntry,
  b: EventTimelineEntry,
): number {
  const t = a.at.localeCompare(b.at);
  if (t) return t;
  if (a.dir !== b.dir) return a.dir === "in" ? -1 : 1;
  return a.mailId - b.mailId;
}

export type TimelineMail = {
  id: number;
  dir: "in" | "out";
  at: string;
  /** Stage 0 conversation key (falls back to the mail id when unknown). */
  conversationKey: string | null;
  subject?: string;
  bodyText?: string;
  /** Position from conversation triage when known. */
  position?: string | null;
};

export type StoredMailEvent = {
  event: MailEvent;
  waitingUntil?: string | null;
  source?: MailEventSource;
  confidence?: number | null;
  scheduledAt?: string | null;
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
  const sorted = [...input.mails].sort((a, b) => {
    const t = a.at.localeCompare(b.at);
    if (t) return t;
    if (a.dir !== b.dir) return a.dir === "in" ? -1 : 1;
    return a.id - b.id;
  });
  const byConversation = new Map<string, EventTimelineEntry[]>();
  const out: EventTimelineEntry[] = [];

  for (const mail of sorted) {
    const convKey = mail.conversationKey || `mail:${mail.id}`;
    const prior = byConversation.get(convKey) || [];
    let entry: EventTimelineEntry | null = null;
    const pos = mail.position?.trim() || null;

    const stored = input.events.get(mail.id);
    if (stored) {
      entry = {
        mailId: mail.id,
        at: mail.at,
        dir: mail.dir,
        event: stored.event,
        origin: "stored",
        ...(stored.source ? { source: stored.source } : {}),
        waitingUntil: stored.waitingUntil ?? null,
        confidence: stored.confidence ?? null,
        scheduledAt: stored.scheduledAt ?? null,
        pos,
      };
    } else if (mail.dir === "out") {
      entry = {
        mailId: mail.id,
        at: mail.at,
        dir: "out",
        event: structuralOutboundEvent(prior, mail),
        origin: "structural",
        pos,
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
          pos,
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

/**
 * True when any event of the timeline is a degraded fallback (intent /
 * structural rule / regex) instead of an AI-verified stage 3 label — the UI
 * shows the row as "unverified".
 */
export function timelineUnverified(timeline: EventTimelineEntry[]): boolean {
  return timeline.some(
    (e) =>
      e.origin !== "stored" ||
      e.source === "regex" ||
      (e.event === "rejection" &&
        e.source === "ai" &&
        typeof e.confidence === "number" &&
        e.confidence < LOW_CONFIDENCE),
  );
}

type CompactEntry = {
  m: number;
  t: string;
  d: "in" | "out";
  e: MailEvent;
  o?: EventTimelineEntry["origin"];
  s?: MailEventSource;
  w?: string | null;
  c?: number | null;
  p?: string | null;
  x?: string | null;
};

export function serializeTimeline(timeline: EventTimelineEntry[]): string {
  const compact: CompactEntry[] = timeline.map((e) => ({
    m: e.mailId,
    t: e.at,
    d: e.dir,
    e: e.event,
    o: e.origin,
    ...(e.source ? { s: e.source } : {}),
    ...(e.waitingUntil ? { w: e.waitingUntil } : {}),
    ...(typeof e.confidence === "number" ? { c: e.confidence } : {}),
    ...(e.pos ? { p: e.pos } : {}),
    ...(e.scheduledAt ? { x: e.scheduledAt } : {}),
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
        ...(item.s ? { source: item.s } : {}),
        waitingUntil: item.w ?? null,
        confidence: typeof item.c === "number" ? item.c : null,
        pos: typeof item.p === "string" ? item.p : null,
        scheduledAt: typeof item.x === "string" ? item.x : null,
      });
    }
    return out;
  } catch {
    return null;
  }
}
