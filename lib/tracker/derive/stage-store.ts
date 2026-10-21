/**
 * Persistence contracts for the AI stages (architecture §2.6.6–§2.6.8).
 * Stage 1 (triage) → conversation_analysis + sender_roles.
 * Stage 3 (event extraction) → mail_events.
 * Both are cached by conversation fingerprint + prompt version; the AI calls
 * themselves implement the provider interfaces below.
 */

import { and, eq } from "drizzle-orm";
import { getDb, getSqlite } from "@/lib/db/client";
import {
  conversationAnalysis,
  mailConversations,
  mailEvents,
  senderRoles,
} from "@/lib/db/schema";
import type { MailEvent, MailEventSource } from "./events";

export type SenderRole = "employer" | "ats" | "agency" | "job_board" | "personal";

export const INTERMEDIARY_ROLES: ReadonlySet<SenderRole> = new Set([
  "ats",
  "agency",
  "job_board",
]);

/** One message of a cleaned conversation transcript (stage 1 / 3 input). */
export type TranscriptMessage = {
  mailId: number;
  dir: "in" | "out";
  at: string;
  from: string;
  to: string;
  subject: string;
  /** Quoted history and the user's signature stripped. */
  body: string;
};

export type ConversationTranscript = {
  conversationId: string;
  fingerprint: string;
  messages: TranscriptMessage[];
};

export type TriageResult = {
  isJobProcess: boolean;
  employer: string | null;
  intermediary: string | null;
  intermediaryKind: "ats" | "agency" | "job_board" | null;
  position: string | null;
  refCode: string | null;
  counterpartEmail: string | null;
  /** Domains the model judged to be intermediaries (never identity keys). */
  senderRoles?: { domain: string; role: SenderRole }[];
};

export type ExtractedEvent = {
  mailId: number;
  event: MailEvent;
  confidence: number;
  waitingUntil?: string | null;
  /** Interview / meeting day YYYY-MM-DD when stated. */
  scheduledAt?: string | null;
};

/** Stage 1 provider (wave 2: LLM). */
export interface ConversationTriageProvider {
  readonly model: string;
  readonly promptVersion: number;
  triage(conv: ConversationTranscript): Promise<TriageResult>;
}

/** Stage 3 provider (wave 2: LLM; eval: fixture oracle). */
export interface ConversationEventProvider {
  readonly model: string;
  readonly promptVersion: number;
  extract(conv: ConversationTranscript): Promise<ExtractedEvent[]>;
}

export function getCachedTriage(
  conversationId: string,
  fingerprint: string,
  promptVersion: number,
): TriageResult | null {
  const row = getDb()
    .select()
    .from(conversationAnalysis)
    .where(eq(conversationAnalysis.conversationId, conversationId))
    .get();
  if (
    !row ||
    row.state !== "ok" ||
    row.fingerprint !== fingerprint ||
    row.promptVersion !== promptVersion
  ) {
    return null;
  }
  return rowToTriage(row);
}

function rowToTriage(row: typeof conversationAnalysis.$inferSelect): TriageResult {
  return {
    isJobProcess: Boolean(row.isJobProcess),
    employer: row.employer,
    intermediary: row.intermediary,
    intermediaryKind:
      (row.intermediaryKind as TriageResult["intermediaryKind"]) ?? null,
    position: row.position,
    refCode: row.refCode,
    counterpartEmail: row.counterpartEmail,
  };
}

/** Latest stored triage regardless of fingerprint (null when never ok). */
export function getLatestTriage(conversationId: string): TriageResult | null {
  const row = getDb()
    .select()
    .from(conversationAnalysis)
    .where(eq(conversationAnalysis.conversationId, conversationId))
    .get();
  return row && row.state === "ok" ? rowToTriage(row) : null;
}

export function getTriageState(conversationId: string): {
  state: string;
  attempts: number;
  fingerprint: string;
  promptVersion: number;
  createdAt: string;
} | null {
  const row = getDb()
    .select()
    .from(conversationAnalysis)
    .where(eq(conversationAnalysis.conversationId, conversationId))
    .get();
  if (!row) return null;
  return {
    state: row.state,
    attempts: row.attempts,
    fingerprint: row.fingerprint,
    promptVersion: row.promptVersion,
    createdAt: row.createdAt,
  };
}

/** AI gave no usable answer: keep the conversation unverified (no guessed fields). */
export function saveTriageFailure(
  conv: { conversationId: string; fingerprint: string },
  error: string,
  meta: { model: string; promptVersion: number },
): void {
  const prev = getTriageState(conv.conversationId);
  const now = new Date().toISOString();
  const values = {
    conversationId: conv.conversationId,
    isJobProcess: 1,
    employer: null,
    intermediary: null,
    intermediaryKind: null,
    position: null,
    refCode: null,
    counterpartEmail: null,
    model: meta.model,
    promptVersion: meta.promptVersion,
    fingerprint: conv.fingerprint,
    createdAt: now,
    state: "failed",
    attempts: (prev?.state === "failed" ? prev.attempts : 0) + 1,
    error: error.slice(0, 300),
  };
  getDb()
    .insert(conversationAnalysis)
    .values(values)
    .onConflictDoUpdate({ target: conversationAnalysis.conversationId, set: values })
    .run();
}

export function saveTriage(
  conv: { conversationId: string; fingerprint: string },
  result: TriageResult,
  meta: { model: string; promptVersion: number; accountId: string },
): void {
  const now = new Date().toISOString();
  const sqlite = getSqlite();
  sqlite.transaction(() => {
    const values = {
      conversationId: conv.conversationId,
      isJobProcess: result.isJobProcess ? 1 : 0,
      employer: result.employer,
      intermediary: result.intermediary,
      intermediaryKind: result.intermediaryKind,
      position: result.position,
      refCode: result.refCode,
      counterpartEmail: result.counterpartEmail,
      model: meta.model,
      promptVersion: meta.promptVersion,
      fingerprint: conv.fingerprint,
      createdAt: now,
      state: "ok",
      attempts: 0,
      error: null,
    };
    getDb()
      .insert(conversationAnalysis)
      .values(values)
      .onConflictDoUpdate({
        target: conversationAnalysis.conversationId,
        set: values,
      })
      .run();
    for (const r of result.senderRoles || []) {
      upsertSenderRole(meta.accountId, r.domain, r.role, "ai");
    }
  })();
}

export function upsertSenderRole(
  accountId: string,
  domain: string,
  role: SenderRole,
  source: "ai" | "user" | "rule",
): void {
  const existing = getDb()
    .select()
    .from(senderRoles)
    .where(
      and(eq(senderRoles.accountId, accountId), eq(senderRoles.domain, domain)),
    )
    .get();
  // A user decision is never overwritten by AI.
  if (existing?.source === "user" && source !== "user") return;
  // Once seen as an intermediary, a domain never keys identity again unless
  // the user says so (one conversation may name the agency as employer).
  if (
    existing &&
    source !== "user" &&
    INTERMEDIARY_ROLES.has(existing.role as SenderRole) &&
    !INTERMEDIARY_ROLES.has(role)
  ) {
    return;
  }
  const values = {
    accountId,
    domain: domain.toLowerCase(),
    role,
    source,
    updatedAt: new Date().toISOString(),
  };
  getDb()
    .insert(senderRoles)
    .values(values)
    .onConflictDoUpdate({
      target: [senderRoles.accountId, senderRoles.domain],
      set: values,
    })
    .run();
}

export function listSenderRoles(
  accountId: string,
): { domain: string; role: SenderRole; source: string }[] {
  return getDb()
    .select()
    .from(senderRoles)
    .where(eq(senderRoles.accountId, accountId))
    .all()
    .map((r) => ({ domain: r.domain, role: r.role as SenderRole, source: r.source }));
}

/** Domains that must not be used as identity keys (stage 2). */
export function intermediaryDomains(accountId: string): Set<string> {
  return new Set(
    getDb()
      .select()
      .from(senderRoles)
      .where(eq(senderRoles.accountId, accountId))
      .all()
      .filter((r) => INTERMEDIARY_ROLES.has(r.role as SenderRole))
      .map((r) => r.domain),
  );
}

/**
 * Replace stage 3 events for the given mails of one conversation; with
 * `fingerprint` also records the conversation's stage 3 cache key.
 */
export function saveMailEvents(
  conversationId: string,
  events: ExtractedEvent[],
  meta: {
    source: MailEventSource;
    model?: string;
    promptVersion?: number;
    fingerprint?: string;
  },
): void {
  const now = new Date().toISOString();
  const sqlite = getSqlite();
  sqlite.transaction(() => {
    if (meta.fingerprint) {
      getDb()
        .update(mailConversations)
        .set({
          eventsFingerprint: meta.fingerprint,
          eventsPromptVersion: meta.promptVersion ?? null,
          eventsState: "ok",
          eventsAttempts: 0,
          eventsAt: now,
        })
        .where(eq(mailConversations.id, conversationId))
        .run();
    }
    for (const e of events) {
      const values = {
        mailId: e.mailId,
        conversationId,
        event: e.event,
        waitingUntil: e.waitingUntil ?? null,
        confidence: e.confidence,
        source: meta.source,
        model: meta.model ?? null,
        promptVersion: meta.promptVersion ?? null,
        createdAt: now,
        scheduledAt: e.scheduledAt ?? null,
      };
      getDb()
        .insert(mailEvents)
        .values(values)
        .onConflictDoUpdate({ target: mailEvents.mailId, set: values })
        .run();
    }
  })();
}

/** Stage 3 failed: fallback events stay in place (row shows unverified). */
export function markEventsFailed(
  conversationId: string,
  meta: { fingerprint: string; promptVersion: number },
): void {
  const row = getDb()
    .select({ attempts: mailConversations.eventsAttempts, state: mailConversations.eventsState })
    .from(mailConversations)
    .where(eq(mailConversations.id, conversationId))
    .get();
  getDb()
    .update(mailConversations)
    .set({
      eventsFingerprint: meta.fingerprint,
      eventsPromptVersion: meta.promptVersion,
      eventsState: "failed",
      eventsAttempts: (row?.state === "failed" ? row.attempts : 0) + 1,
      eventsAt: new Date().toISOString(),
    })
    .where(eq(mailConversations.id, conversationId))
    .run();
}
