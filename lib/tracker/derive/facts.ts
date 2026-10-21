/**
 * Pure fact computation from assigned mails + events (time-independent).
 * The event timeline is the input of the stage 4 state machine (effective.ts).
 */

import { flagsFromIntent } from "../agents/mail-signals";
import {
  resolveMailIntent,
  type MailIntent,
  type MailIntentMap,
} from "../mail-kind";
import { normalizeMailText } from "../signals";
import { assembleConversations, conversationKeyByMail } from "./conversation-graph";
import {
  buildEventTimeline,
  PASSIVE_INBOUND_EVENTS,
  type EventTimelineEntry,
  type FallbackIntent,
  type StoredMailEvent,
} from "./events";

export type FactMail = {
  id: number;
  folder: string;
  fromAddr: string;
  toAddr: string;
  subject: string;
  dateIso: string;
  bodyText: string;
  snippet: string;
  threadId?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  referencesHdr?: string | null;
  direction?: string | null;
  /** K1: gone mails still contribute to facts */
  goneAt?: string | null;
};

import type { ItemFlags } from "./flags";

export type { ItemFlags } from "./flags";
export { factsToFlagsJson, parseFlagsJson } from "./flags";

export type ItemFacts = {
  lastOutboundAt: string | null;
  lastInboundAt: string | null;
  lastMeaningfulInboundAt: string | null;
  waitingUntil: string | null;
  lastIntent: MailIntent | null;
  followUpCount: number;
  hasOutbound: boolean;
  hasInbound: boolean;
  isThanksSent: boolean;
  fromResearchOnly: boolean;
  lastInboundSubject: string | null;
  lastInboundBody: string | null;
  lastInboundFrom: string | null;
  flags: ItemFlags;
  /** AI / prior classification hint (not time-resolved status); unused by effective() */
  aiStatus: string | null;
  /** Chronological per-mail events — stage 4 input. */
  timeline: EventTimelineEntry[];
};

export function isOutboundFolder(folder: string): boolean {
  return folder === "SENT" || folder === "sent";
}

/** Self-sent copies can sit in INBOX; sync stores them with direction "out". */
export function isOutboundMail(m: Pick<FactMail, "folder" | "direction">): boolean {
  return isOutboundFolder(m.folder) || m.direction === "out";
}

/** Fallback intent per inbound mail: cached AI intent merged with regex. */
function fallbackIntents(
  mails: FactMail[],
  intents: MailIntentMap,
): Map<number, FallbackIntent> {
  const out = new Map<number, FallbackIntent>();
  for (const m of mails) {
    if (isOutboundMail(m)) continue;
    const rec = intents.get(m.id);
    const intent = resolveMailIntent({
      mailId: m.id,
      subject: m.subject,
      body: normalizeMailText(m.bodyText || m.snippet || ""),
      fromAddr: m.fromAddr,
      toAddr: m.toAddr,
      folder: "INBOX",
      ai: rec?.intent,
    });
    out.set(m.id, { intent, waitingUntil: rec?.waitingUntil ?? null });
  }
  return out;
}

/** Pure: item mails + stored events + fallback intents → event timeline. */
export function computeTimeline(input: {
  mails: FactMail[];
  intents: MailIntentMap;
  events?: ReadonlyMap<number, StoredMailEvent>;
}): EventTimelineEntry[] {
  const convKeys = conversationKeyByMail(
    assembleConversations(
      input.mails.map((m) => ({
        id: m.id,
        threadId: m.threadId ?? null,
        messageId: m.messageId ?? null,
        inReplyTo: m.inReplyTo ?? null,
        referencesHdr: m.referencesHdr ?? null,
        at: m.dateIso,
      })),
    ),
  );
  return buildEventTimeline({
    mails: input.mails.map((m) => ({
      id: m.id,
      dir: isOutboundMail(m) ? "out" : "in",
      at: m.dateIso,
      conversationKey: convKeys.get(m.id) ?? null,
      subject: m.subject,
      bodyText: normalizeMailText(m.bodyText || m.snippet || ""),
    })),
    events: input.events ?? new Map(),
    intents: fallbackIntents(input.mails, input.intents),
  });
}

/** Thanks counts only when it answers a still-standing rejection. */
function thanksAfterRejection(timeline: EventTimelineEntry[]): boolean {
  let rejected = false;
  let thanks = false;
  for (const e of timeline) {
    if (e.dir === "in" && e.event === "rejection") {
      rejected = true;
      thanks = false;
    } else if (e.dir === "out" && e.event === "thanks_sent" && rejected) {
      thanks = true;
    }
  }
  return thanks;
}

/**
 * Pure: assigned mails (including gone_at) → time-independent facts.
 */
export function computeFacts(input: {
  assignedMails: FactMail[];
  intents: MailIntentMap;
  events?: ReadonlyMap<number, StoredMailEvent>;
  researchCandidate: boolean;
  aiStatusHint?: string | null;
}): ItemFacts {
  const linkedMails = input.assignedMails;
  const outbounds = linkedMails.filter((m) => isOutboundMail(m));
  const inbounds = linkedMails.filter((m) => !isOutboundMail(m));

  const lastOutboundAt = outbounds.map((m) => m.dateIso).sort().at(-1) ?? null;
  const lastInboundAt = inbounds.map((m) => m.dateIso).sort().at(-1) ?? null;

  const timeline = computeTimeline({
    mails: linkedMails,
    intents: input.intents,
    events: input.events,
  });

  const inboundEvents = timeline.filter((e) => e.dir === "in");
  const lastMeaningful = [...inboundEvents]
    .reverse()
    .find((e) => !PASSIVE_INBOUND_EVENTS.has(e.event));
  const lastInboundEvent = inboundEvents.at(-1) ?? null;

  const lastInboundMail = [...inbounds]
    .sort((a, b) => a.dateIso.localeCompare(b.dateIso))
    .at(-1);
  const lastInboundBody = lastInboundMail
    ? normalizeMailText(lastInboundMail.bodyText || lastInboundMail.snippet || "")
    : null;
  const lastIntent = lastInboundMail
    ? resolveMailIntent({
        mailId: lastInboundMail.id,
        subject: lastInboundMail.subject,
        body: lastInboundBody || "",
        fromAddr: lastInboundMail.fromAddr,
        toAddr: lastInboundMail.toAddr,
        folder: "INBOX",
        ai: input.intents.get(lastInboundMail.id)?.intent,
      })
    : null;
  const lastFlags = flagsFromIntent(lastIntent || "unknown");
  const isThanksSent = thanksAfterRejection(timeline);

  return {
    lastOutboundAt,
    lastInboundAt,
    lastMeaningfulInboundAt: lastMeaningful?.at ?? null,
    waitingUntil:
      lastInboundEvent?.event === "ooo"
        ? lastInboundEvent.waitingUntil ?? null
        : null,
    lastIntent,
    followUpCount: timeline.filter((e) => e.event === "follow_up_sent").length,
    hasOutbound: outbounds.length > 0,
    hasInbound: inbounds.length > 0,
    isThanksSent,
    fromResearchOnly:
      linkedMails.length === 0 && Boolean(input.researchCandidate),
    lastInboundSubject: lastInboundMail?.subject ?? null,
    lastInboundBody,
    lastInboundFrom: lastInboundMail?.fromAddr ?? null,
    flags: {
      autoReply: lastFlags.isAutoReply,
      ackOnly: lastFlags.isAckOnly,
      clickAction: lastFlags.isClickAction,
      rejected: lastMeaningful?.event === "rejection",
      thanksSent: isThanksSent,
      bounced: lastIntent === "bounce",
    },
    aiStatus: input.aiStatusHint ?? null,
    timeline,
  };
}
