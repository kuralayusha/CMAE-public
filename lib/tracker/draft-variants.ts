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

/**
 * Shared voice for reply, follow-up, and thank-you drafts.
 * User note outranks variant structure when they conflict.
 */
export const MAIL_VOICE_RULES = `
HOW THE MAIL SHOULD SOUND:

Write like a person at work. Plain, short, professional. Not a polished assistant.

- Everyday words. No literary or very formal language.
- Do not open with filler ("I hope this email finds you well", "I wanted to reach out", "I am writing to inform you", "as per our conversation", "circling back", "touching base", "please do not hesitate", "I would be delighted", "kindly").
- Do not recap their mail. They already know what they wrote. Name the topic in a few words only when the reply would be unclear without it ("Thursday at 14:00 works for me").
- Say each point once. Do not rephrase it in the next sentence.
- Most replies are 2 to 4 sentences. Follow-ups and thank-yous are 2 to 3. Stop when the point is done.
- One greeting, then the point, then one closing line. Nothing else.
- Spelling and grammar stay correct. No typos, no slang, no emoji.
- Punctuation: period, comma, and question mark. No em dash, en dash, semicolon, or ellipsis. Do not stack marks. A colon, or a single exclamation, only when that sentence really needs it.
- Plain text. No markdown or bullet lists unless the user note asks for a list.
- Greeting uses their real name when known. Never invent a name.
- SUBJECT continues the thread with Re: and the anchor subject. Do not start a new subject.
- Never invent facts, numbers, dates, or reasons. If you do not have it, leave it out.

USER NOTE (only when one is present):
- It is the brief for this email, not a chatbot request and not text to paste in.
- Do what it asks: tone, what to say, what to skip, length, and format.
- It outranks the variant structure below when they disagree.
- Still only write the email. Do not add a recap or extra topics they did not ask for.
`.trim();

const FOLLOW_UP_BASE = `
FOLLOW-UP (in-thread, no reply yet):
- Shorter than the first application. Two or three sentences.
- One soft line that you applied earlier. Never "you didn't reply" or "still waiting".
- One easy question, or a short note that you are still interested.
- A new point only if the user note or the context has a real one. Otherwise skip it.
- One short line that the CV is attached again.
- Do not paste the first mail or walk through the CV.
`.trim();

const THANKS_BASE = `
THANK-YOU (in-thread, after a rejection):
- Two or three sentences. Thanks for their time, then the variant beat in one sentence.
- No argument, no bitterness, no guilt.
`.trim();

const REPLY_BASE = `
REPLY (in-thread, to their latest mail):
- Do the variant task. Do not walk through their email point by point unless they asked several concrete questions.
- Salary, notice period, start date, and work type come only from Candidate preferences. Never invent figures.
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
- Do not pitch future roles. One soft line that the door stays open is enough.
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
- Make it easy to decline. No obligation.
- If the user note names a focus area, prefer that. Otherwise keep the ask generic.
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
- Explicitly welcome hearing about future roles that fit (use the user note for area/role if provided).
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
      "Write a soft follow-up after no reply. Short, polite, easy to answer.",
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
      "Write a soft follow-up that includes one new grounded value point from the user note / context. Never invent wins.",
    craftGuide: `${FOLLOW_UP_BASE}

VARIANT RULES (followup_value)
- Add one real update only if the user note or the context has one. Otherwise stay with the soft check-in.
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
- Tone: a last, gracious check-in. No guilt.
- Imply you will assume timing is not right if silent; still welcome a reply later.
- Keep it to two sentences unless the user note asks for more. Skip extra updates unless the note has one.
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
      "Reply answering their latest questions/asks. Use Candidate preferences and the user note; never invent figures.",
    craftGuide: `${REPLY_BASE}

VARIANT RULES (reply_answer)
- Answer what they asked. One sentence per question is enough.
- Use the user note for anything the thread does not already answer.
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
      "Confirm an interview invitation. Thank them and confirm the slot from the user note when provided.",
    craftGuide: `${REPLY_BASE}

VARIANT RULES (reply_confirm_interview)
- Thank them; confirm attendance.
- If the user note gives a preferred time, confirm that. If not, confirm the slot they offered when it is clear. Otherwise ask which offered slot works.
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
      "Politely request a reschedule / new slot. Use availability from the user note when provided.",
    craftGuide: `${REPLY_BASE}

VARIANT RULES (reply_reschedule)
- Apologize briefly for the conflict; stay warm.
- Propose alternatives only from the user note. If none, ask for other times without inventing availability.
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
      "Accept the offer gratefully. Mention next-step details only from preferences / the user note.",
    craftGuide: `${REPLY_BASE}

VARIANT RULES (reply_accept_offer)
- Clear acceptance + thanks.
- Start date and logistics only if prefs or the user note already have them. Never invent them.
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
      "Politely decline the offer. Short, professional; leave door open. Do not invent reasons beyond the user note.",
    craftGuide: `${REPLY_BASE}

VARIANT RULES (reply_decline_offer)
- Clear but kind decline.
- Give a reason only if the user note provides one. Otherwise leave it out.
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
      "Negotiate terms using only Candidate preferences and the user note. Collaborative, not aggressive.",
    craftGuide: `${REPLY_BASE}

VARIANT RULES (reply_negotiate)
- Discuss only numbers/terms present in prefs or the user note. Never invent targets.
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
      "Ask 1 to 3 clarifying questions. Prefer turning the user note into clear questions.",
    craftGuide: `${REPLY_BASE}

VARIANT RULES (reply_ask_clarify)
- 1 to 3 short questions that unblock the process.
- If the user note contains the question, phrase it clearly. Do not invent extra topics.
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
      "Withdraw from the hiring process politely. Short and gracious; reason only from the user note.",
    craftGuide: `${REPLY_BASE}

VARIANT RULES (reply_decline_process)
- Clear withdrawal / stepping back.
- Thank them; leave door open if natural.
- Give a reason only if the user note provides one.
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
USER NOTE (this is the brief for the email. Follow it.):
"""
${note}
"""
Turn this into the mail itself: the tone they asked for, the points they want mentioned, the things they want left out, and the format they described.
If it conflicts with the variant structure, follow this note.
Do not answer the note as a chat. Do not paste it. Do not add a recap or extra topics.
Facts written here are true. Do not invent beyond this note, the preferences, and the thread.
`;
}
