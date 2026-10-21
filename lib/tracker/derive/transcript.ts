/**
 * Cleaned conversation transcripts for the AI stages (architecture §2.6.6).
 * Pure (no DB): structure only — quoted history, the user's own signature
 * and size budgets. Meaning is left to the model.
 *
 * Bodies arrive whitespace-collapsed, so cleaning works on word shingles
 * rather than lines:
 * - quoted history = runs of words already present in an earlier message of
 *   the same conversation, plus `>`-quoted tails and dash banners;
 * - signature = word runs that recur across many of the user's sent mails.
 */

import { normalizeMailText } from "../signals";
import type {
  ConversationTranscript,
  TranscriptMessage,
} from "./stage-store";

export type TranscriptSourceMail = {
  id: number;
  dir: "in" | "out";
  at: string;
  from: string;
  to: string;
  subject: string;
  body: string;
};

export type SignatureModel = { shingles: Set<string> };

export type TranscriptBudget = {
  /** Max characters per message body. */
  perMessage: number;
  /** Max characters of all bodies of one conversation. */
  perConversation: number;
};

export const DEFAULT_TRANSCRIPT_BUDGET: TranscriptBudget = {
  perMessage: 1500,
  perConversation: 7000,
};

const SHINGLE = 6;

function fixSoftBreaks(s: string): string {
  // Quoted-printable soft breaks survive whitespace collapsing as "wor= d".
  return s.replace(/(\p{L})=\s+(?=\p{L})/gu, "$1");
}

/** Left-over quoted-printable escapes ("f=FCr", "=C3=BC"): UTF-8, else Latin-1. */
function decodeStrayQp(s: string): string {
  if (!/=[0-9A-F]{2}/.test(s)) return s;
  return s.replace(/(?:=[0-9A-F]{2})+/g, (run) => {
    const bytes = Buffer.from(
      run.split("=").filter(Boolean).map((h) => Number.parseInt(h, 16)),
    );
    const utf8 = bytes.toString("utf8");
    return utf8.includes("\uFFFD") ? bytes.toString("latin1") : utf8;
  });
}

function prepare(raw: string): string {
  return decodeStrayQp(fixSoftBreaks(normalizeMailText(raw || "")))
    .replace(/\s+/g, " ")
    .trim();
}

function tokenKey(token: string): string {
  return token
    .toLowerCase()
    .replace(/^[>*_"'“”„(]+|[*_"'“”,.;:!?)]+$/g, "");
}

function keyedTokens(tokens: string[]): { key: string; idx: number }[] {
  const out: { key: string; idx: number }[] = [];
  tokens.forEach((tok, idx) => {
    const key = tokenKey(tok);
    if (key) out.push({ key, idx });
  });
  return out;
}

function shinglesOf(text: string, n = SHINGLE): Set<string> {
  const keys = keyedTokens(text.split(" ")).map((k) => k.key);
  const out = new Set<string>();
  for (let i = 0; i + n <= keys.length; i += 1) {
    out.add(keys.slice(i, i + n).join(" "));
  }
  return out;
}

/** Token indices covered by any shingle of `known`. */
function coveredMask(tokens: string[], known: Set<string>, n = SHINGLE): boolean[] {
  const mask = new Array<boolean>(tokens.length).fill(false);
  if (!known.size) return mask;
  const keyed = keyedTokens(tokens);
  for (let i = 0; i + n <= keyed.length; i += 1) {
    const sh = keyed
      .slice(i, i + n)
      .map((k) => k.key)
      .join(" ");
    if (!known.has(sh)) continue;
    for (let j = keyed[i]!.idx; j <= keyed[i + n - 1]!.idx; j += 1) mask[j] = true;
  }
  return mask;
}

/** Drop covered runs of at least `minRun` tokens. */
function dropRuns(tokens: string[], mask: boolean[], minRun: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (!mask[i]) {
      out.push(tokens[i]!);
      i += 1;
      continue;
    }
    let j = i;
    while (j < tokens.length && mask[j]) j += 1;
    if (j - i < minRun) out.push(...tokens.slice(i, j));
    i = j;
  }
  return out;
}

/** Start of a `>`-quoted tail: first `>` marker followed by more markers. */
function quoteTailStart(s: string): number {
  const re = /(?:^|\s)>(?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const window = s.slice(m.index, m.index + 600);
    if ((window.match(/(?:^|\s)>(?=\s|$)/g) || []).length >= 3) return m.index;
  }
  return -1;
}

/** "-----Original Message-----" style banners in any language. */
function bannerStart(s: string): number {
  const m = s.match(/-{4,}\s?[^-]{3,40}?\s?-{4,}|_{8,}/);
  return m?.index ?? -1;
}

/** Learn the user's recurring signature from their sent bodies. */
export function learnSignature(sentBodies: string[]): SignatureModel {
  const counts = new Map<string, number>();
  for (const raw of sentBodies) {
    const text = prepare(raw);
    const cut = quoteTailStart(text);
    const own = cut >= 0 ? text.slice(0, cut) : text;
    // Signatures live in the tail of the user's own text.
    const tail = own.split(" ").slice(-60).join(" ");
    for (const sh of shinglesOf(tail, 4)) {
      counts.set(sh, (counts.get(sh) || 0) + 1);
    }
  }
  const min = Math.max(3, Math.ceil(sentBodies.length * 0.15));
  const shingles = new Set<string>();
  for (const [sh, n] of counts) if (n >= min) shingles.add(sh);
  return { shingles };
}

export function cleanMailBody(
  raw: string,
  ctx: {
    /** Earlier messages of the same conversation (raw bodies). */
    priorBodies: string[];
    signature?: SignatureModel;
    userEmails?: string[];
  },
): string {
  let text = prepare(raw);
  const cuts = [quoteTailStart(text), bannerStart(text)].filter((i) => i > 0);
  if (cuts.length) text = text.slice(0, Math.min(...cuts)).trim();

  let tokens = text.split(" ").filter(Boolean);
  if (ctx.priorBodies.length) {
    const known = new Set<string>();
    for (const b of ctx.priorBodies) for (const sh of shinglesOf(prepare(b))) known.add(sh);
    const mask = coveredMask(tokens, known);
    // Quoted tail: the first long known run from which most of the rest is
    // known (short shared phrases like greetings do not start a quote).
    const runFrom = new Array<number>(tokens.length + 1).fill(0);
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
      runFrom[i] = mask[i] ? runFrom[i + 1]! + 1 : 0;
    }
    let coveredAfter = 0;
    let tailStart = tokens.length;
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
      if (mask[i]) coveredAfter += 1;
      const rest = tokens.length - i;
      if (runFrom[i]! >= 12 && (i === 0 || !mask[i - 1]) && coveredAfter / rest >= 0.6) {
        tailStart = i;
      }
    }
    // A message that repeats an earlier one keeps only its new words.
    if (tailStart === 0) tailStart = tokens.length;
    tokens = dropRuns(tokens.slice(0, tailStart), mask, 12);
  }
  if (ctx.signature?.shingles.size) {
    tokens = dropRuns(tokens, coveredMask(tokens, ctx.signature.shingles, 4), 4);
  }
  const own = new Set((ctx.userEmails || []).map((e) => e.toLowerCase()));
  if (own.size) tokens = tokens.filter((tok) => !own.has(tokenKey(tok)));
  return tokens.join(" ").trim();
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Chronological cleaned transcript within the size budget. Middle messages
 * shrink first (first + last messages carry the most identity / state).
 */
export function buildTranscript(
  conv: { conversationId: string; fingerprint: string },
  mails: TranscriptSourceMail[],
  ctx: {
    signature?: SignatureModel;
    userEmails?: string[];
    budget?: TranscriptBudget;
  },
): ConversationTranscript {
  const budget = ctx.budget ?? DEFAULT_TRANSCRIPT_BUDGET;
  const sorted = [...mails].sort(
    (a, b) => a.at.localeCompare(b.at) || a.id - b.id,
  );
  const messages: TranscriptMessage[] = [];
  const prior: string[] = [];
  for (const m of sorted) {
    const body = cleanMailBody(m.body, {
      priorBodies: prior,
      signature: m.dir === "out" ? ctx.signature : undefined,
      userEmails: ctx.userEmails,
    });
    prior.push(m.body);
    messages.push({
      mailId: m.id,
      dir: m.dir,
      at: m.at,
      from: m.from,
      to: m.to,
      subject: m.subject,
      body: clip(body, budget.perMessage),
    });
  }

  const total = () => messages.reduce((n, m) => n + m.body.length, 0);
  if (total() > budget.perConversation && messages.length > 4) {
    for (let i = 1; i < messages.length - 3; i += 1) {
      messages[i]!.body = clip(messages[i]!.body, 400);
    }
  }
  if (total() > budget.perConversation) {
    const each = Math.max(200, Math.floor(budget.perConversation / messages.length));
    for (const m of messages) m.body = clip(m.body, each);
  }
  return { ...conv, messages };
}

function who(addr: string, userEmails: Set<string>): string {
  const lower = (addr || "").toLowerCase();
  for (const e of userEmails) if (e && lower.includes(e)) return "ME";
  return addr.slice(0, 120);
}

/** Prompt rendering shared by stage 1 and stage 3. */
export function renderTranscript(
  label: string,
  t: ConversationTranscript,
  userEmails: string[],
): string {
  const own = new Set(userEmails.map((e) => e.toLowerCase()));
  const lines = [`### ${label} (${t.messages.length} message${t.messages.length === 1 ? "" : "s"})`];
  for (const m of t.messages) {
    lines.push(
      `[mail ${m.mailId}] ${m.at.slice(0, 16).replace("T", " ")} ${m.dir === "out" ? "OUTGOING (sent by ME)" : "INCOMING"}`,
      `From: ${who(m.from, own)}`,
      `To: ${who(m.to, own).slice(0, 200)}`,
      `Subject: ${m.subject.slice(0, 200)}`,
      m.body ? `Body: ${m.body}` : "Body: (empty)",
      "",
    );
  }
  return lines.join("\n");
}

export function transcriptChars(t: ConversationTranscript): number {
  return t.messages.reduce(
    (n, m) => n + m.body.length + m.subject.length + 120,
    0,
  );
}
