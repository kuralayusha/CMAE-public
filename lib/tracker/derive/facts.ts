/**
 * Pure fact computation from assigned mails + intents (time-independent).
 */

import { flagsFromIntent } from "../agents/mail-signals";
import {
  isMeaningfulIntent,
  resolveMailIntent,
  type MailIntent,
  type MailIntentMap,
} from "../mail-kind";
import { normalizeMailText } from "../signals";

export type FactMail = {
  id: number;
  folder: string;
  fromAddr: string;
  toAddr: string;
  subject: string;
  dateIso: string;
  bodyText: string;
  snippet: string;
  /** K1: gone mails still contribute to facts */
  goneAt?: string | null;
};

export type ItemFlags = {
  autoReply: boolean;
  ackOnly: boolean;
  clickAction: boolean;
  rejected: boolean;
  thanksSent: boolean;
  bounced: boolean;
};

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
  /** AI / prior classification hint (not time-resolved status) */
  aiStatus: string | null;
};

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

/**
 * Pure: assigned mails (including gone_at) → time-independent facts.
 */
export function computeFacts(input: {
  assignedMails: FactMail[];
  intents: MailIntentMap;
  researchCandidate: boolean;
  priorFollowUpCount?: number;
  aiStatusHint?: string | null;
}): ItemFacts {
  const linkedMails = input.assignedMails;
  const outbounds = linkedMails.filter(
    (m) => m.folder === "SENT" || m.folder === "sent",
  );
  const inbounds = linkedMails.filter(
    (m) => m.folder === "INBOX" || m.folder === "inbox" || m.folder === "all",
  );
  // Prefer explicit folder; direction-agnostic fallback: non-SENT as inbound
  const inboundFallback =
    inbounds.length > 0
      ? inbounds
      : linkedMails.filter((m) => m.folder !== "SENT");
  const outboundFallback =
    outbounds.length > 0
      ? outbounds
      : linkedMails.filter((m) => m.folder === "SENT");

  const lastOutboundAt =
    outboundFallback.map((m) => m.dateIso).sort().at(-1) ?? null;
  const lastInboundAt =
    inboundFallback.map((m) => m.dateIso).sort().at(-1) ?? null;

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
      ai: input.intents.get(mailId)?.intent,
    });

  const meaningfulInbounds = inboundFallback.filter((m) => {
    const body = normalizeMailText(m.bodyText || m.snippet || "");
    const intent = intentFor(m.id, m.subject, body, m.fromAddr, m.toAddr);
    return isMeaningfulIntent(intent);
  });
  const lastMeaningfulInboundAt =
    meaningfulInbounds.map((m) => m.dateIso).sort().at(-1) ?? null;
  const lastMeaningfulMail = [...meaningfulInbounds]
    .sort((a, b) => a.dateIso.localeCompare(b.dateIso))
    .at(-1);
  const lastInboundMail = [...inboundFallback]
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
    : null;
  const lastFlags = flagsFromIntent(lastIntent || "unknown");
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

  const isThanksSent = detectThanks(linkedMails);
  const oooUntil =
    lastFlags.isOoo && lastInboundMail
      ? input.intents.get(lastInboundMail.id)?.waitingUntil || null
      : null;

  return {
    lastOutboundAt,
    lastInboundAt,
    lastMeaningfulInboundAt,
    waitingUntil: oooUntil,
    lastIntent,
    followUpCount: Math.max(
      input.priorFollowUpCount ?? 0,
      countFollowUps(linkedMails),
    ),
    hasOutbound: outboundFallback.length > 0,
    hasInbound: inboundFallback.length > 0,
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
      rejected: lastFlags.isRejected || meaningfulIntent === "rejection",
      thanksSent: isThanksSent,
      bounced: lastIntent === "bounce",
    },
    aiStatus: input.aiStatusHint ?? null,
  };
}

export function factsToFlagsJson(flags: ItemFlags): string {
  return JSON.stringify(flags);
}

export function parseFlagsJson(raw: string | null | undefined): ItemFlags {
  const empty: ItemFlags = {
    autoReply: false,
    ackOnly: false,
    clickAction: false,
    rejected: false,
    thanksSent: false,
    bounced: false,
  };
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw) as Partial<ItemFlags>;
    return {
      autoReply: Boolean(v.autoReply),
      ackOnly: Boolean(v.ackOnly),
      clickAction: Boolean(v.clickAction),
      rejected: Boolean(v.rejected),
      thanksSent: Boolean(v.thanksSent),
      bounced: Boolean(v.bounced),
    };
  } catch {
    return empty;
  }
}
