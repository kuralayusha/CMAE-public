/**
 * Prepare-draft variant registry: modal options + LLM craft snippets.
 */

import type { DraftKind } from "./types";

export const USER_NOTE_MAX = 2000;

export type DraftPrepareKind = Exclude<DraftKind, "application">;

export type ThanksVariantId =
  | "thanks_simple"
  | "thanks_feedback"
  | "thanks_future";

export type FollowUpVariantId =
  | "followup_soft"
  | "followup_value"
  | "followup_closing";

export type ReplyVariantId =
  | "reply_answer"
  | "reply_confirm_interview"
  | "reply_reschedule"
  | "reply_accept_offer"
  | "reply_decline_offer"
  | "reply_negotiate"
  | "reply_ask_clarify"
  | "reply_decline_process";

export type DraftVariantId =
  | ThanksVariantId
  | FollowUpVariantId
  | ReplyVariantId;

export type DraftVariantDef = {
  id: DraftVariantId;
  kind: DraftPrepareKind;
  /** i18n: tracker.variant.<id>.label */
  labelKey: string;
  /** i18n: tracker.variant.<id>.hint */
  hintKey: string;
  /** i18n: tracker.variant.<id>.placeholder */
  placeholderKey: string;
  /** UI hint that a user note is especially useful */
  noteRecommended: boolean;
  intent: string;
  craftGuide: string;
};

const FOLLOW_UP_BASE = `
FOLLOW-UP CRAFT (follow closely — even shorter than the first application mail):

LENGTH & STRUCTURE
- Ideal: 50–80 words. Hard cap ~100. Must feel shorter than the original application.
- 2–3 short sentences; a single short paragraph is fine.
- Easy to answer in seconds — no long explanations.

THREADING (subject)
- This is an in-thread REPLY. SUBJECT must continue the prior thread with Re: …
- Prefer the thread anchor subject. Do not invent a new subject that breaks context.

BODY STRUCTURE (in this order)
1) Greeting: Use the real name if known. Otherwise a natural generic greeting. Never invent a name.
2) Soft reminder (1 sentence): Briefly mention the earlier application — no accusation.
3) Empathy / tone: Acknowledge they may be busy. Never "you didn't reply" / "still waiting".
4) Optional new value (1 sentence, only if grounded in User notes / CV / research): otherwise SKIP.
5) Low-pressure ask (1 sentence).
6) Mention CV is attached again.
7) Thank them and close warmly, then exactly one closing line per SIGNATURE RULES.

TONE
- Kind, light, professional — not stiff, not pleading, not passive-aggressive.
- Do NOT copy-paste the first mail. Do NOT restate the whole CV.

LANGUAGE
- Match the thread language when clear; otherwise preferred language.
`.trim();

const THANKS_BASE = `
THANKS CRAFT (after rejection — in-thread reply):

LENGTH
- Ideal: 40–70 words. Hard cap ~90.

STRUCTURE
1) Greeting (real name if known; never invent).
2) Brief thanks for their time / consideration.
3) Variant-specific beat (see TASK / VARIANT RULES).
4) Leave the door open warmly — no bitterness, no guilt.
5) Close per SIGNATURE RULES.

TONE
- Gracious, short, professional. Never argue the rejection.
`.trim();

const REPLY_BASE = `
REPLY CRAFT (in-thread reply to their latest inbound):

- Be professional and specific to their ask and the chosen variant.
- If they ask about salary, notice, start date, or employment type, answer from Candidate preferences — never invent figures.
- Prefer short paragraphs; easy to answer.
- SUBJECT must continue the thread with Re: …
`.trim();

const THANKS_VARIANTS: DraftVariantDef[] = [
  {
    id: "thanks_simple",
    kind: "thanks",
    labelKey: "tracker.variant.thanks_simple.label",
    hintKey: "tracker.variant.thanks_simple.hint",
    placeholderKey: "tracker.variant.thanks_simple.placeholder",
    noteRecommended: false,
    intent:
      "Write a short thank-you after a rejection. Gracious, leave door open, no feedback request, no bitterness.",
    craftGuide: `${THANKS_BASE}

VARIANT RULES (thanks_simple)
- Do NOT ask for feedback.
- Do NOT pitch future roles aggressively — a single soft door-open is enough.
`,
  },
  {
    id: "thanks_feedback",
    kind: "thanks",
    labelKey: "tracker.variant.thanks_feedback.label",
    hintKey: "tracker.variant.thanks_feedback.hint",
    placeholderKey: "tracker.variant.thanks_feedback.placeholder",
    noteRecommended: false,
    intent:
      "Write a thank-you after a rejection that also politely asks for brief feedback. No pressure if they cannot share any.",
    craftGuide: `${THANKS_BASE}

VARIANT RULES (thanks_feedback)
- After thanks, add ONE gentle sentence asking for any brief feedback that might help next time.
- Make it easy to decline — no obligation implied.
- If User notes name a focus area, prefer that; otherwise keep the ask generic.
`,
  },
  {
    id: "thanks_future",
    kind: "thanks",
    labelKey: "tracker.variant.thanks_future.label",
    hintKey: "tracker.variant.thanks_future.hint",
    placeholderKey: "tracker.variant.thanks_future.placeholder",
    noteRecommended: false,
    intent:
      "Write a thank-you after rejection that emphasizes staying in touch for future fitting roles. No feedback ask.",
    craftGuide: `${THANKS_BASE}

VARIANT RULES (thanks_future)
- Do NOT ask for feedback.
- Explicitly welcome hearing about future roles that fit (use User notes for area/role if provided).
`,
  },
];

const FOLLOW_UP_VARIANTS: DraftVariantDef[] = [
  {
    id: "followup_soft",
    kind: "follow_up",
    labelKey: "tracker.variant.followup_soft.label",
    hintKey: "tracker.variant.followup_soft.hint",
    placeholderKey: "tracker.variant.followup_soft.placeholder",
    noteRecommended: false,
    intent:
      "Write a soft follow-up after no reply. Follow FOLLOW-UP CRAFT. Polite, low-pressure, easy to answer.",
    craftGuide: FOLLOW_UP_BASE,
  },
  {
    id: "followup_value",
    kind: "follow_up",
    labelKey: "tracker.variant.followup_value.label",
    hintKey: "tracker.variant.followup_value.hint",
    placeholderKey: "tracker.variant.followup_value.placeholder",
    noteRecommended: true,
    intent:
      "Write a soft follow-up that includes one new grounded value point from User notes / context. Never invent wins.",
    craftGuide: `${FOLLOW_UP_BASE}

VARIANT RULES (followup_value)
- Step 4 (new value) is required IF User notes or context provide a real win/news item; otherwise skip and stay soft.
- Never invent certificates, projects, or company news.
`,
  },
  {
    id: "followup_closing",
    kind: "follow_up",
    labelKey: "tracker.variant.followup_closing.label",
    hintKey: "tracker.variant.followup_closing.hint",
    placeholderKey: "tracker.variant.followup_closing.placeholder",
    noteRecommended: false,
    intent:
      "Write a closing follow-up: last soft check-in. Imply you will not chase further; leave the door open.",
    craftGuide: `${FOLLOW_UP_BASE}

VARIANT RULES (followup_closing)
- Tone: final, gracious check-in — not guilt.
- Imply you will assume timing is not right if silent; still welcome a reply later.
- Keep shorter; skip heavy new-value pitches unless User notes provide one.
`,
  },
];

const REPLY_VARIANTS: DraftVariantDef[] = [
  {
    id: "reply_answer",
    kind: "reply",
    labelKey: "tracker.variant.reply_answer.label",
    hintKey: "tracker.variant.reply_answer.hint",
    placeholderKey: "tracker.variant.reply_answer.placeholder",
    noteRecommended: false,
    intent:
      "Reply answering their latest questions/asks. Use Candidate preferences and User notes; never invent figures.",
    craftGuide: `${REPLY_BASE}

VARIANT RULES (reply_answer)
- Address their points directly. Use User notes as grounding for answers you would otherwise lack.
`,
  },
  {
    id: "reply_confirm_interview",
    kind: "reply",
    labelKey: "tracker.variant.reply_confirm_interview.label",
    hintKey: "tracker.variant.reply_confirm_interview.hint",
    placeholderKey: "tracker.variant.reply_confirm_interview.placeholder",
    noteRecommended: true,
    intent:
      "Confirm an interview invitation. Thank them and confirm the slot from User notes when provided.",
    craftGuide: `${REPLY_BASE}

VARIANT RULES (reply_confirm_interview)
- Thank them; confirm attendance.
- If User notes give a preferred time/slot, confirm that. If none, confirm the slot they offered when clear; otherwise ask briefly which offered slot works.
`,
  },
  {
    id: "reply_reschedule",
    kind: "reply",
    labelKey: "tracker.variant.reply_reschedule.label",
    hintKey: "tracker.variant.reply_reschedule.hint",
    placeholderKey: "tracker.variant.reply_reschedule.placeholder",
    noteRecommended: true,
    intent:
      "Politely request a reschedule / new slot. Use availability from User notes when provided.",
    craftGuide: `${REPLY_BASE}

VARIANT RULES (reply_reschedule)
- Apologize briefly for the conflict; stay warm.
- Propose alternatives only from User notes. If none, ask for other times without inventing availability.
`,
  },
  {
    id: "reply_accept_offer",
    kind: "reply",
    labelKey: "tracker.variant.reply_accept_offer.label",
    hintKey: "tracker.variant.reply_accept_offer.hint",
    placeholderKey: "tracker.variant.reply_accept_offer.placeholder",
    noteRecommended: false,
    intent:
      "Accept the offer gratefully. Mention next-step details only from preferences / User notes.",
    craftGuide: `${REPLY_BASE}

VARIANT RULES (reply_accept_offer)
- Clear acceptance + thanks.
- Start date / logistics only if known from prefs or User notes — never invent.
`,
  },
  {
    id: "reply_decline_offer",
    kind: "reply",
    labelKey: "tracker.variant.reply_decline_offer.label",
    hintKey: "tracker.variant.reply_decline_offer.hint",
    placeholderKey: "tracker.variant.reply_decline_offer.placeholder",
    noteRecommended: false,
    intent:
      "Politely decline the offer. Short, professional; leave door open. Do not invent reasons beyond User notes.",
    craftGuide: `${REPLY_BASE}

VARIANT RULES (reply_decline_offer)
- Clear but kind decline.
- Reason only if User notes provide one; otherwise omit (no fake excuses).
`,
  },
  {
    id: "reply_negotiate",
    kind: "reply",
    labelKey: "tracker.variant.reply_negotiate.label",
    hintKey: "tracker.variant.reply_negotiate.hint",
    placeholderKey: "tracker.variant.reply_negotiate.placeholder",
    noteRecommended: true,
    intent:
      "Negotiate terms using only Candidate preferences and User notes. Collaborative, not aggressive.",
    craftGuide: `${REPLY_BASE}

VARIANT RULES (reply_negotiate)
- Discuss only numbers/terms present in prefs or User notes. Never invent targets.
- Collaborative tone; invite discussion.
`,
  },
  {
    id: "reply_ask_clarify",
    kind: "reply",
    labelKey: "tracker.variant.reply_ask_clarify.label",
    hintKey: "tracker.variant.reply_ask_clarify.hint",
    placeholderKey: "tracker.variant.reply_ask_clarify.placeholder",
    noteRecommended: true,
    intent:
      "Ask 1–3 clarifying questions. Prefer turning User notes into clear questions.",
    craftGuide: `${REPLY_BASE}

VARIANT RULES (reply_ask_clarify)
- 1–3 short questions that unblock the process.
- If User notes contain the question(s), phrase them professionally; do not invent extra topics.
`,
  },
  {
    id: "reply_decline_process",
    kind: "reply",
    labelKey: "tracker.variant.reply_decline_process.label",
    hintKey: "tracker.variant.reply_decline_process.hint",
    placeholderKey: "tracker.variant.reply_decline_process.placeholder",
    noteRecommended: false,
    intent:
      "Withdraw from the hiring process politely. Short and gracious; reason only from User notes.",
    craftGuide: `${REPLY_BASE}

VARIANT RULES (reply_decline_process)
- Clear withdrawal / stepping back.
- Thank them; leave door open if natural.
- Reason only if User notes provide one.
`,
  },
];

const BY_KIND: Record<DraftPrepareKind, DraftVariantDef[]> = {
  thanks: THANKS_VARIANTS,
  follow_up: FOLLOW_UP_VARIANTS,
  reply: REPLY_VARIANTS,
};

const BY_ID = new Map<DraftVariantId, DraftVariantDef>(
  [...THANKS_VARIANTS, ...FOLLOW_UP_VARIANTS, ...REPLY_VARIANTS].map((v) => [
    v.id,
    v,
  ]),
);

export function listVariantsForKind(kind: DraftPrepareKind): DraftVariantDef[] {
  return BY_KIND[kind];
}

export function getVariantDef(
  kind: DraftPrepareKind,
  variantId: string | undefined | null,
): DraftVariantDef | null {
  if (!variantId) return null;
  const def = BY_ID.get(variantId as DraftVariantId);
  if (!def || def.kind !== kind) return null;
  return def;
}

export function resolveVariant(
  kind: DraftPrepareKind,
  variantId: string | undefined | null,
  ctx?: { followUpCount?: number; eventKinds?: string[] },
): DraftVariantDef {
  const explicit = getVariantDef(kind, variantId);
  if (explicit) return explicit;
  const fallbackId = pickDefaultVariantId(kind, ctx || {});
  return BY_ID.get(fallbackId)!;
}

export type VariantPickContext = {
  followUpCount?: number;
  /** Timeline event kinds when available (e.g. interview, accepted). */
  eventKinds?: string[];
};

export function pickDefaultVariantId(
  kind: DraftPrepareKind,
  ctx: VariantPickContext = {},
): DraftVariantId {
  const kinds = new Set((ctx.eventKinds || []).map((k) => k.toLowerCase()));

  if (kind === "thanks") {
    if (kinds.has("interview")) return "thanks_feedback";
    return "thanks_simple";
  }

  if (kind === "follow_up") {
    if ((ctx.followUpCount || 0) >= 1) return "followup_closing";
    return "followup_soft";
  }

  // reply
  if (kinds.has("accepted")) return "reply_accept_offer";
  if (kinds.has("interview")) return "reply_confirm_interview";
  return "reply_answer";
}

/** Client-safe metadata (no craft strings needed in UI). */
export type DraftVariantMeta = {
  id: DraftVariantId;
  kind: DraftPrepareKind;
  labelKey: string;
  hintKey: string;
  placeholderKey: string;
  noteRecommended: boolean;
};

export function listVariantMeta(kind: DraftPrepareKind): DraftVariantMeta[] {
  return listVariantsForKind(kind).map(
    ({ id, kind: k, labelKey, hintKey, placeholderKey, noteRecommended }) => ({
      id,
      kind: k,
      labelKey,
      hintKey,
      placeholderKey,
      noteRecommended,
    }),
  );
}

export function normalizeUserNote(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.slice(0, USER_NOTE_MAX);
}

export function formatUserNotesBlock(userNote: string): string {
  const note = normalizeUserNote(userNote);
  if (!note) return "";
  return `
User notes (plain text from candidate — use as grounding facts; do not invent beyond this):
"""
${note}
"""
`;
}
