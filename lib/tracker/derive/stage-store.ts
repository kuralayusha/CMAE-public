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
    row.fingerprint !== fingerprint ||
    row.promptVersion !== promptVersion
  ) {
    return null;
  }
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

/** Replace stage 3 events for the given mails of one conversation. */
export function saveMailEvents(
  conversationId: string,
  events: ExtractedEvent[],
  meta: { source: MailEventSource; model?: string; promptVersion?: number },
): void {
  const now = new Date().toISOString();
  const sqlite = getSqlite();
  sqlite.transaction(() => {
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
      };
      getDb()
        .insert(mailEvents)
        .values(values)
        .onConflictDoUpdate({ target: mailEvents.mailId, set: values })
        .run();
    }
  })();
}
