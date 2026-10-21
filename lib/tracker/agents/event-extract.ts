/**
 * Stage 3 — per-mail process events from the whole conversation
 * (architecture §2.6.8). Pure: the LLM is injected.
 *
 * Every mail of the transcript (SENT included) gets exactly one event. An
 * answer is accepted per conversation only when it labels every mail with an
 * event valid for that mail's direction; otherwise the conversation is
 * retried once and then reported as failed (callers fall back to the
 * unverified intent / structural events).
 */

import {
  MAIL_EVENTS,
  normalizeMailEvent,
  type MailEvent,
} from "../derive/events";
import { extractJson, mapLimit, type LlmFn } from "../llm-core";
import { renderTranscript, transcriptChars } from "../derive/transcript";
import type {
  ConversationTranscript,
  ExtractedEvent,
} from "../derive/stage-store";
import { packBatches } from "./conversation-triage";

export const EVENTS_PROMPT_VERSION = 1;

export const OUTBOUND_EVENTS: ReadonlySet<MailEvent> = new Set([
  "application_sent",
  "follow_up_sent",
  "thanks_sent",
  "withdrawn",
  "other",
]);

export const INBOUND_EVENTS: ReadonlySet<MailEvent> = new Set(
  MAIL_EVENTS.filter(
    (e) => !["application_sent", "follow_up_sent", "thanks_sent", "withdrawn"].includes(e),
  ),
);

/** Context per conversation: the identified process + other threads of it. */
export type EventContext = {
  employer?: string | null;
  position?: string | null;
  /** Earlier mails of the same application in other conversations. */
  otherActivity?: { at: string; dir: "in" | "out"; event?: MailEvent | null; subject: string }[];
};

export type EventBatchOptions = {
  llm: LlmFn;
  userEmails: string[];
  maxCharsPerCall?: number;
  maxConversationsPerCall?: number;
  concurrency?: number;
  signal?: AbortSignal;
  onCall?: (info: { conversations: number; ok: number; ms: number; error?: string }) => void;
};

export type EventOutcome =
  | { ok: true; events: ExtractedEvent[] }
  | { ok: false; error: string };

export function buildEventPrompt(
  convs: { label: string; transcript: ConversationTranscript; context?: EventContext }[],
  opts: { userEmails: string[] },
): string {
  const blocks = convs.map((c) => {
    const ctx = c.context;
    const head: string[] = [];
    if (ctx?.employer) {
      head.push(`Application: ${ctx.employer}${ctx.position ? ` — ${ctx.position}` : ""}`);
    }
    if (ctx?.otherActivity?.length) {
      head.push("Earlier mails of this application in OTHER threads (context only, do not label):");
      for (const a of ctx.otherActivity.slice(-8)) {
        head.push(
          `  ${a.at.slice(0, 10)} ${a.dir === "out" ? "OUTGOING" : "INCOMING"}${a.event ? ` [${a.event}]` : ""}: ${a.subject.slice(0, 120)}`,
        );
      }
    }
    return `${head.join("\n")}${head.length ? "\n" : ""}${renderTranscript(`Conversation ${c.label}`, c.transcript, opts.userEmails)}`;
  });

  return `You label every email of job-application conversations from ONE person's mailbox ("ME").
Mails can be in any language. Judge the communicative purpose, never keywords. Read the whole conversation: a mail's meaning depends on what came before it.

Give EVERY mail exactly one event.

OUTGOING mails (written by ME) — only these events:
- application_sent: ME applies for a role (incl. speculative/unsolicited application, sending CV for a role, applying again for a different role).
- follow_up_sent: ME asks about the status of an application already sent, without answering anything new.
- thanks_sent: ME's short courtesy reply that only thanks / closes the loop (typically after a rejection), with no new question, document or scheduling.
- withdrawn: ME withdraws the application or declines the process / offer.
- other: any other outgoing mail — answering questions, sending requested info or documents, scheduling, confirming an appointment, asking questions.

INCOMING mails — only these events:
- auto_ack: automated receipt confirmation of the application (system / no-reply sender, ATS confirmation).
- ack: a person or company confirms receipt / says they will review, with nothing required from ME.
- info_request: they ask ME a question or request information/documents that ME must answer by email.
- interview_invite: invitation to an interview / call / meeting, or a request to pick a time for one.
- assessment: a test task, coding challenge, or recorded/AI interview to complete.
- action_required: ME must do something outside email that is NOT optional (complete profile or application in a portal, give or renew data-retention consent, verify an account that blocks the application).
- rejection: the application is declined / position filled / not moving forward.
- offer: a job offer.
- ooo: out-of-office / absence auto-reply. Set waiting_until (YYYY-MM-DD) when a return date is stated.
- other: anything else (appointment confirmations, one-time passcodes, generic status updates, notifications that need nothing).

confidence: 0–1, how sure you are.

Return ONLY JSON:
{"conversations":[{"id":"C1","mails":[{"mail":123,"event":"application_sent","confidence":0.9,"waiting_until":null}]}]}

${blocks.join("\n")}`;
}

type RawEventConv = {
  id?: unknown;
  mails?: { mail?: unknown; mailId?: unknown; event?: unknown; confidence?: unknown; waiting_until?: unknown }[];
};

function isoDay(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

/** Validate one conversation answer against the transcript (all-or-nothing). */
export function validateEvents(
  transcript: ConversationTranscript,
  raw: RawEventConv | undefined,
): ExtractedEvent[] | null {
  if (!raw || !Array.isArray(raw.mails)) return null;
  const byId = new Map<number, ExtractedEvent>();
  const dirOf = new Map(transcript.messages.map((m) => [m.mailId, m.dir]));
  for (const r of raw.mails) {
    const mailId = Number(r?.mail ?? r?.mailId);
    const dir = dirOf.get(mailId);
    if (!dir) continue;
    const event = normalizeMailEvent(typeof r.event === "string" ? r.event.trim().toLowerCase() : r.event);
    if (!event) return null;
    const allowed = dir === "out" ? OUTBOUND_EVENTS : INBOUND_EVENTS;
    if (!allowed.has(event)) return null;
    const c = Number(r.confidence);
    byId.set(mailId, {
      mailId,
      event,
      confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.7,
      waitingUntil: event === "ooo" ? isoDay(r.waiting_until) : null,
    });
  }
  if (byId.size !== transcript.messages.length) return null;
  return transcript.messages.map((m) => byId.get(m.mailId)!);
}

type EventJob = { transcript: ConversationTranscript; context?: EventContext };

async function runEventCall(
  batch: EventJob[],
  opts: EventBatchOptions,
): Promise<Map<string, ExtractedEvent[]>> {
  const labeled = batch.map((j, i) => ({ label: `C${i + 1}`, ...j }));
  const t0 = Date.now();
  try {
    const text = await opts.llm(buildEventPrompt(labeled, opts));
    const parsed = extractJson<{ conversations?: RawEventConv[] } | RawEventConv[]>(text);
    const rows = Array.isArray(parsed) ? parsed : parsed?.conversations;
    const byLabel = new Map<string, RawEventConv>();
    if (Array.isArray(rows)) {
      for (const r of rows) byLabel.set(String(r?.id ?? "").trim(), r);
    }
    // Single conversation answered without the wrapper id.
    if (labeled.length === 1 && !byLabel.size && Array.isArray(rows) && rows[0]) {
      byLabel.set("C1", rows[0]);
    }
    const out = new Map<string, ExtractedEvent[]>();
    for (const l of labeled) {
      const ev = validateEvents(l.transcript, byLabel.get(l.label));
      if (ev) out.set(l.transcript.conversationId, ev);
    }
    opts.onCall?.({ conversations: batch.length, ok: out.size, ms: Date.now() - t0 });
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.onCall?.({ conversations: batch.length, ok: 0, ms: Date.now() - t0, error: msg });
    if (opts.signal?.aborted) throw err;
    return new Map();
  }
}

export async function extractConversationEvents(
  jobs: EventJob[],
  opts: EventBatchOptions,
): Promise<Map<string, EventOutcome>> {
  const maxChars = opts.maxCharsPerCall ?? 24_000;
  const maxItems = opts.maxConversationsPerCall ?? 6;
  const concurrency = opts.concurrency ?? 3;
  const done = new Map<string, ExtractedEvent[]>();
  const size = (j: EventJob) =>
    transcriptChars(j.transcript) + (j.context?.otherActivity?.length || 0) * 80;

  const round = async (items: EventJob[], chars: number, per: number) => {
    const batches = packBatches(items, size, chars, per);
    const results = await mapLimit(batches, concurrency, (b) => {
      if (opts.signal?.aborted) throw new Error("aborted");
      return runEventCall(b, opts);
    });
    for (const r of results) for (const [id, v] of r) done.set(id, v);
  };

  await round(jobs, maxChars, maxItems);
  const missing = jobs.filter((j) => !done.has(j.transcript.conversationId));
  if (missing.length) await round(missing, Math.round(maxChars / 2), 1);

  const out = new Map<string, EventOutcome>();
  for (const j of jobs) {
    const ev = done.get(j.transcript.conversationId);
    out.set(
      j.transcript.conversationId,
      ev ? { ok: true, events: ev } : { ok: false, error: "no valid event answer" },
    );
  }
  return out;
}
