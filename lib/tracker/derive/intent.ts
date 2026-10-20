/**
 * Intent cache (mail_intents) + header-based bounce / OOO.
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mailIntents } from "@/lib/db/schema";
import {
  normalizeIntent,
  regexMailIntent,
  type MailIntent,
  type MailIntentMap,
  type MailIntentRecord,
} from "../mail-kind";
import { parseAutoFlags, type AutoFlags } from "./noise";

/** Bump when the AI intent prompt changes. */
export const INTENT_PROMPT_VERSION = 1;
export const INTENT_MODEL = "composer-2.5";

export type IntentSource = "ai" | "regex" | "header";

/** Header-only classification (RFC 3834 / delivery-status). */
export function headerIntent(
  autoFlags: AutoFlags | null | undefined,
): { intent: MailIntent; source: IntentSource } | null {
  if (!autoFlags) return null;
  if (autoFlags.bounce) {
    return { intent: "bounce", source: "header" };
  }
  const auto = (autoFlags.autoSubmitted || "").toLowerCase();
  if (auto.includes("auto-replied")) {
    return { intent: "ooo", source: "header" };
  }
  return null;
}

export function getCachedIntent(
  mailId: number,
  promptVersion = INTENT_PROMPT_VERSION,
): MailIntentRecord | null {
  const row = getDb()
    .select()
    .from(mailIntents)
    .where(eq(mailIntents.mailId, mailId))
    .get();
  if (!row) return null;
  if (row.promptVersion !== promptVersion) return null;
  return {
    mailId: row.mailId,
    intent: normalizeIntent(row.intent),
    waitingUntil: row.waitingUntil,
  };
}

export function upsertMailIntent(input: {
  mailId: number;
  intent: MailIntent;
  waitingUntil?: string | null;
  confidence?: number | null;
  source: IntentSource;
  model?: string;
  promptVersion?: number;
}): void {
  const now = new Date().toISOString();
  const db = getDb();
  const existing = db
    .select()
    .from(mailIntents)
    .where(eq(mailIntents.mailId, input.mailId))
    .get();
  const values = {
    mailId: input.mailId,
    intent: input.intent,
    waitingUntil: input.waitingUntil ?? null,
    confidence: input.confidence ?? null,
    source: input.source,
    model: input.model ?? INTENT_MODEL,
    promptVersion: input.promptVersion ?? INTENT_PROMPT_VERSION,
    createdAt: now,
  };
  if (existing) {
    db.update(mailIntents)
      .set({
        intent: values.intent,
        waitingUntil: values.waitingUntil,
        confidence: values.confidence,
        source: values.source,
        model: values.model,
        promptVersion: values.promptVersion,
        createdAt: now,
      })
      .where(eq(mailIntents.mailId, input.mailId))
      .run();
  } else {
    db.insert(mailIntents).values(values).run();
  }
}

/**
 * Resolve intent preferring cache → header → regex.
 * Returns whether regex was used (needs_classification).
 */
export function resolveIntentFast(input: {
  mailId: number;
  subject: string;
  body: string;
  fromAddr: string;
  toAddr: string;
  autoFlagsRaw: string | null;
}): {
  record: MailIntentRecord;
  source: IntentSource;
  needsClassification: boolean;
} {
  const cached = getCachedIntent(input.mailId);
  if (cached) {
    return {
      record: cached,
      source: "ai",
      needsClassification: false,
    };
  }

  const flags = parseAutoFlags(input.autoFlagsRaw);
  const header = headerIntent(flags);
  if (header) {
    upsertMailIntent({
      mailId: input.mailId,
      intent: header.intent,
      source: "header",
      confidence: 1,
    });
    return {
      record: {
        mailId: input.mailId,
        intent: header.intent,
        waitingUntil: null,
      },
      source: "header",
      needsClassification: false,
    };
  }

  const regex = regexMailIntent(
    input.subject,
    input.body,
    input.fromAddr,
    input.toAddr,
  );
  const intent = regex || "unknown";
  upsertMailIntent({
    mailId: input.mailId,
    intent,
    source: "regex",
    confidence: regex ? 0.6 : 0.2,
  });
  return {
    record: {
      mailId: input.mailId,
      intent,
      waitingUntil: null,
    },
    source: "regex",
    // Regex is provisional — classify_retry should upgrade.
    needsClassification: true,
  };
}

export function intentsMapFromRecords(
  records: MailIntentRecord[],
): MailIntentMap {
  const map: MailIntentMap = new Map();
  for (const r of records) map.set(r.mailId, r);
  return map;
}
