/**
 * Language-agnostic mail intent for tracker silence / status.
 * AI is primary; DE/EN regex is a boost/fallback — merged with OR for "noise".
 */

import {
  detectAckOnly,
  detectAutoAck,
  detectClickAction,
  detectOooAway,
  detectOptionalPortalLink,
  detectRejection,
  isNonJobMail,
  normalizeMailText,
} from "./signals";

export const MAIL_INTENTS = [
  "human_reply",
  "ack",
  "auto_ack",
  "ooo",
  "rejection",
  "click_action",
  "optional_portal",
  "non_job",
  "bounce",
  "unknown",
] as const;

export type MailIntent = (typeof MAIL_INTENTS)[number];

export type MailIntentRecord = {
  mailId: number;
  intent: MailIntent;
  waitingUntil: string | null;
  /** Short reason from AI (any language) */
  reason?: string;
};

const NOISE: ReadonlySet<MailIntent> = new Set([
  "ack",
  "auto_ack",
  "optional_portal",
  "click_action",
  "ooo",
  "non_job",
]);

export function isSilenceNoise(intent: MailIntent): boolean {
  return NOISE.has(intent);
}

/** Counts as a real word from them for silence clock + rejection checks */
export function isMeaningfulIntent(intent: MailIntent): boolean {
  return intent === "human_reply" || intent === "rejection";
}

export function isAckish(intent: MailIntent): boolean {
  return (
    intent === "ack" ||
    intent === "auto_ack" ||
    intent === "optional_portal"
  );
}

export function normalizeIntent(v: unknown): MailIntent {
  if (typeof v === "string" && (MAIL_INTENTS as readonly string[]).includes(v)) {
    return v as MailIntent;
  }
  return "unknown";
}

/** Fast DE/EN heuristic — null when no clear match */
export function regexMailIntent(
  subject: string,
  body: string,
  fromAddr = "",
  toAddr = "",
): MailIntent | null {
  const text = normalizeMailText(body);
  if (
    isNonJobMail({
      subject,
      fromAddr,
      toAddr,
      bodyPreview: text,
      snippet: text,
    })
  ) {
    return "non_job";
  }
  if (detectOooAway(subject, text)) return "ooo";
  if (detectRejection(subject, text)) return "rejection";
  if (detectOptionalPortalLink(subject, text)) return "optional_portal";
  if (detectClickAction(subject, text, fromAddr)) return "click_action";
  if (detectAutoAck(subject, text)) return "auto_ack";
  if (detectAckOnly(subject, text, fromAddr)) return "ack";
  return null;
}

/**
 * Merge AI + regex.
 * Rejection / OOO / CTA / ACK noise: either side wins (safer silence clock).
 * Otherwise prefer AI when it is not unknown.
 */
export function mergeMailIntent(
  ai: MailIntent | null | undefined,
  regex: MailIntent | null | undefined,
): MailIntent {
  const a = ai && ai !== "unknown" ? ai : null;
  const r = regex || null;

  const pick = (...kinds: MailIntent[]): MailIntent | null => {
    for (const k of kinds) {
      if (a === k || r === k) return k;
    }
    return null;
  };

  return (
    pick("bounce") ||
    pick("rejection") ||
    pick("ooo") ||
    pick("click_action") ||
    pick("auto_ack") ||
    pick("optional_portal") ||
    pick("ack") ||
    pick("non_job") ||
    a ||
    r ||
    "unknown"
  );
}

export function resolveMailIntent(input: {
  mailId: number;
  subject: string;
  body: string;
  fromAddr?: string;
  toAddr?: string;
  folder?: string;
  ai?: MailIntent | null;
}): MailIntent {
  if (input.folder === "SENT") return "human_reply";
  const regex = regexMailIntent(
    input.subject,
    input.body,
    input.fromAddr || "",
    input.toAddr || "",
  );
  return mergeMailIntent(input.ai, regex);
}

export type MailIntentMap = Map<number, MailIntentRecord>;

export function intentOf(
  map: MailIntentMap | undefined,
  mailId: number,
): MailIntent {
  return map?.get(mailId)?.intent ?? "unknown";
}
