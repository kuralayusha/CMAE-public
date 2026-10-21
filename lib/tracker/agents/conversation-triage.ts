/**
 * Stage 1 — conversation triage (architecture §2.6.6). Pure: the LLM is
 * injected so derive and the eval harness run the same prompt + parser.
 *
 * Several conversations share one call within a character budget. A
 * conversation the model did not answer (or answered with invalid JSON) is
 * retried once in a smaller call; after that it is reported as failed —
 * never filled with guessed data.
 */

import { extractJson, mapLimit, type LlmFn } from "../llm-core";
import { renderTranscript, transcriptChars } from "../derive/transcript";
import type {
  ConversationTranscript,
  SenderRole,
  TriageResult,
} from "../derive/stage-store";

export const TRIAGE_PROMPT_VERSION = 3;

const SENDER_ROLES: readonly SenderRole[] = [
  "employer",
  "ats",
  "agency",
  "job_board",
  "personal",
];

export type TriageBatchOptions = {
  llm: LlmFn;
  userEmails: string[];
  /** Known domain → role hints (learned so far; read at each call). */
  knownRoles?: () => { domain: string; role: SenderRole }[];
  /** Called with every accepted answer (sender-role learning). */
  onResults?: (results: Map<string, TriageResult>) => void;
  maxCharsPerCall?: number;
  maxConversationsPerCall?: number;
  concurrency?: number;
  signal?: AbortSignal;
  onCall?: (info: { conversations: number; ok: number; ms: number; error?: string }) => void;
};

export type TriageOutcome =
  | { ok: true; result: TriageResult }
  | { ok: false; error: string };

type RawTriage = {
  id?: unknown;
  is_job_process?: unknown;
  employer?: unknown;
  intermediary?: unknown;
  intermediary_kind?: unknown;
  position?: unknown;
  ref_code?: unknown;
  counterpart_email?: unknown;
  domains?: unknown;
};

export function buildTriagePrompt(
  convs: { label: string; transcript: ConversationTranscript }[],
  opts: { userEmails: string[]; knownRoles?: { domain: string; role: SenderRole }[] },
): string {
  const hints = (opts.knownRoles || [])
    .filter((r) => r.role !== "employer")
    .slice(0, 80)
    .map((r) => `${r.domain}=${r.role}`)
    .join(", ");
  return `You analyse email conversations from ONE person's mailbox ("ME") for a job-application tracker.
Conversations can be in any language (German, English, Turkish, French, Spanish, …). Judge meaning, never keywords.

Judge EACH conversation only from its own messages: the conversations below are unrelated batches from the same mailbox, so never copy an employer, position or client from one conversation into another.

For EACH conversation decide:
- is_job_process: true when the conversation is part of ME's own job search with a specific organisation: ME applying (incl. speculative/unsolicited applications), application receipts, recruiter or hiring-manager messages, interview scheduling, tests, rejections, offers, consent/data-retention or account mails that belong to an application. false for newsletters, job alerts / job recommendation digests, marketing, product/account notifications unrelated to an application, personal or private mail.
- employer: the organisation that would actually employ ME. Never an applicant-tracking system (Personio, Greenhouse, Ashby, Workday, SmartRecruiters, Teamtailor, Recruitee, d.vinci, onlyfy, HRworks …), a job board, or a recruiting agency — unless ME is applying to work AT that company itself. Read subject, body, signature and sender display name to find the real employer. When an agency presents a vacancy at a named client, employer = the client. When an agency only handles ME's general candidacy (registration, consent, profile) with no client named in THIS conversation, employer = the agency. Take the name from the text — company mentions, the sender's signature (e.g. "Best regards, Jane Doe, Example GmbH"), the sender display name — in its usual short form. If the text names no organisation but ME writes directly to (or hears directly from) the organisation's own address (not an ATS, job board, agency or free-mail address), use the organisation that address belongs to, written as a name (e.g. jobs@example-tech.de → "Example Tech"). Never derive names from URL paths or tracking links. null only when none of this identifies the employer.
- intermediary: the ATS / agency / job board that carries the conversation, else null. intermediary_kind: "ats" | "agency" | "job_board" | "none".
- position: the job title if stated, else null. ref_code: an explicit job reference / requisition / Kennziffer / ticket-independent posting id if stated, else null.
- counterpart_email: the address ME corresponds with on the employer/intermediary side (prefer a human; for conversations with only ME's mails, the recipient). null if none.
- domains: the role of every email domain in the conversation other than ME's: "employer" | "ats" | "agency" | "job_board" | "personal" (free-mail / private person).

Messages marked OUTGOING were written by ME. Quoted history and ME's signature were removed.
${hints ? `Known domain roles from earlier conversations (use as hints): ${hints}\n` : ""}
Return ONLY JSON, one entry per conversation id:
{"conversations":[{"id":"C1","is_job_process":true,"employer":"Acme","intermediary":"Personio","intermediary_kind":"ats","position":"Frontend Developer","ref_code":null,"counterpart_email":"jobs@acme.com","domains":[{"domain":"acme.com","role":"employer"},{"domain":"personio.de","role":"ats"}]}]}

${convs.map((c) => renderTranscript(`Conversation ${c.label}`, c.transcript, opts.userEmails)).join("\n")}`;
}

function str(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || /^(null|none|n\/a|unknown)$/i.test(s)) return null;
  return s.slice(0, max);
}

function normalizeTriage(raw: RawTriage): TriageResult | null {
  if (typeof raw.is_job_process !== "boolean") return null;
  const kindRaw = str(raw.intermediary_kind)?.toLowerCase() ?? null;
  const intermediaryKind =
    kindRaw === "ats" || kindRaw === "agency" || kindRaw === "job_board"
      ? kindRaw
      : null;
  const domains: { domain: string; role: SenderRole }[] = [];
  if (Array.isArray(raw.domains)) {
    for (const d of raw.domains as { domain?: unknown; role?: unknown }[]) {
      const domain = str(d?.domain, 120)?.toLowerCase().replace(/^@/, "");
      const role = str(d?.role)?.toLowerCase() as SenderRole | undefined;
      if (domain && role && SENDER_ROLES.includes(role) && domain.includes(".")) {
        domains.push({ domain, role });
      }
    }
  }
  const email = str(raw.counterpart_email, 160)?.toLowerCase() ?? null;
  return {
    isJobProcess: raw.is_job_process,
    employer: raw.is_job_process ? str(raw.employer) : null,
    intermediary: intermediaryKind ? str(raw.intermediary) : null,
    intermediaryKind,
    position: str(raw.position),
    refCode: str(raw.ref_code, 80),
    counterpartEmail: email && email.includes("@") ? email : null,
    senderRoles: domains,
  };
}

/** Parse one model answer → label → result (missing / invalid labels absent). */
export function parseTriageResponse(
  text: string,
  labels: string[],
): Map<string, TriageResult> {
  const out = new Map<string, TriageResult>();
  const parsed = extractJson<{ conversations?: RawTriage[] } | RawTriage[]>(text);
  const rows = Array.isArray(parsed) ? parsed : parsed?.conversations;
  if (!Array.isArray(rows)) return out;
  const valid = new Set(labels);
  for (const row of rows) {
    const label = String(row?.id ?? "").trim();
    if (!valid.has(label) || out.has(label)) continue;
    const result = normalizeTriage(row);
    if (result) out.set(label, result);
  }
  return out;
}

/** Greedy packing by transcript size. */
export function packBatches<T>(
  items: T[],
  size: (item: T) => number,
  maxChars: number,
  maxItems: number,
): T[][] {
  const batches: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  for (const item of items) {
    const n = size(item);
    if (cur.length && (chars + n > maxChars || cur.length >= maxItems)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(item);
    chars += n;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

async function runTriageCall(
  batch: ConversationTranscript[],
  opts: TriageBatchOptions,
): Promise<Map<string, TriageResult>> {
  const labeled = batch.map((transcript, i) => ({ label: `C${i + 1}`, transcript }));
  const t0 = Date.now();
  try {
    const text = await opts.llm(
      buildTriagePrompt(labeled, {
        userEmails: opts.userEmails,
        knownRoles: opts.knownRoles?.(),
      }),
    );
    const parsed = parseTriageResponse(text, labeled.map((l) => l.label));
    const out = new Map<string, TriageResult>();
    for (const l of labeled) {
      const r = parsed.get(l.label);
      if (r) out.set(l.transcript.conversationId, r);
    }
    opts.onResults?.(out);
    opts.onCall?.({ conversations: batch.length, ok: out.size, ms: Date.now() - t0 });
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.onCall?.({ conversations: batch.length, ok: 0, ms: Date.now() - t0, error: msg });
    if (opts.signal?.aborted) throw err;
    return new Map();
  }
}

/**
 * Triage conversations in packed batches; one retry round for anything
 * missing (smaller batches). Every input id gets an outcome.
 */
export async function triageConversations(
  convs: ConversationTranscript[],
  opts: TriageBatchOptions,
): Promise<Map<string, TriageOutcome>> {
  const maxChars = opts.maxCharsPerCall ?? 24_000;
  const maxItems = opts.maxConversationsPerCall ?? 8;
  const concurrency = opts.concurrency ?? 3;
  const done = new Map<string, TriageResult>();

  const round = async (items: ConversationTranscript[], chars: number, per: number) => {
    const batches = packBatches(items, transcriptChars, chars, per);
    const results = await mapLimit(batches, concurrency, (b) => {
      if (opts.signal?.aborted) throw new Error("aborted");
      return runTriageCall(b, opts);
    });
    for (const r of results) for (const [id, v] of r) done.set(id, v);
  };

  await round(convs, maxChars, maxItems);
  const missing = convs.filter((c) => !done.has(c.conversationId));
  if (missing.length) {
    await round(missing, Math.round(maxChars / 2), Math.max(1, Math.ceil(maxItems / 3)));
  }

  const out = new Map<string, TriageOutcome>();
  for (const c of convs) {
    const r = done.get(c.conversationId);
    out.set(
      c.conversationId,
      r ? { ok: true, result: r } : { ok: false, error: "no valid triage answer" },
    );
  }
  return out;
}
