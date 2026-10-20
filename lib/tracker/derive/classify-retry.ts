/**
 * classify_retry job: upgrade regex / needs_classification intents via AI.
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mailMessages, trackerItems } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { getSettingsRow } from "@/lib/settings/service";
import { classifyMailSignals } from "../agents/mail-signals";
import { throwIfSyncCanceled } from "../cancel";
import { normalizeMailText } from "../signals";
import type { MailBrief } from "../match";
import type { SyncProgressFn } from "../types";
import {
  INTENT_PROMPT_VERSION,
  upsertMailIntent,
} from "./intent";
import { refreshItemFacts } from "./refresh-item";
import { getAssignment } from "./assign";

const BATCH = 40;

function toBrief(m: typeof mailMessages.$inferSelect): MailBrief {
  return {
    id: m.id,
    folder: m.folder,
    fromAddr: m.fromAddr,
    toAddr: m.toAddr,
    subject: m.subject,
    dateIso: m.internalDate || m.dateIso,
    snippet: m.snippet,
    threadId: m.threadId,
    bodyPreview: normalizeMailText(m.bodyText || m.snippet || "").slice(0, 600),
  };
}

/**
 * Re-classify mails in needs_classification / items flagged needs_classification.
 */
export async function runClassifyRetry(opts?: {
  onProgress?: SyncProgressFn;
  signal?: AbortSignal;
}): Promise<{ classified: number; stillPending: number }> {
  const log = opts?.onProgress;
  const signal = opts?.signal;
  let db = getDb();
  const followUpDays = getSettingsRow()?.followUpDays ?? 5;

  const pendingMails = db
    .select()
    .from(mailMessages)
    .where(eq(mailMessages.deriveState, "needs_classification"))
    .all()
    .slice(0, BATCH);

  if (!pendingMails.length) {
    // Clear stale item flags when queue empty
    db.update(trackerItems)
      .set({ needsClassification: 0 })
      .where(eq(trackerItems.needsClassification, 1))
      .run();
    return { classified: 0, stillPending: 0 };
  }

  throwIfSyncCanceled(signal);
  log?.(
    "think",
    t("sync.incrementalStart", { count: pendingMails.length }),
  );

  const isInbox = (folder: string) =>
    folder === "INBOX" || folder.toLowerCase() === "inbox";

  const briefs = pendingMails.filter((m) => isInbox(m.folder)).map(toBrief);

  let classified = 0;
  const touched = new Set<number>();

  if (briefs.length) {
    try {
      const map = await classifyMailSignals(briefs, {
        onProgress: log,
        signal,
      });
      db = getDb();
      for (const [mailId, rec] of map) {
        upsertMailIntent({
          mailId,
          intent: rec.intent,
          waitingUntil: rec.waitingUntil,
          source: "ai",
          confidence: 0.9,
          promptVersion: INTENT_PROMPT_VERSION,
        });
        db.update(mailMessages)
          .set({ deriveState: "done" })
          .where(eq(mailMessages.id, mailId))
          .run();
        classified += 1;
        const assign = getAssignment(mailId);
        if (assign) touched.add(assign.itemId);
      }
    } catch (err) {
      // Leave needs_classification; scheduler will backoff via job retry.
      throw err;
    }
  }

  db = getDb();
  // Non-inbox leftovers → done (no inbound intent needed)
  for (const m of pendingMails) {
    if (isInbox(m.folder)) continue;
    db.update(mailMessages)
      .set({ deriveState: "done" })
      .where(eq(mailMessages.id, m.id))
      .run();
  }

  for (const itemId of touched) {
    refreshItemFacts(itemId, new Map(), followUpDays);
    db.update(trackerItems)
      .set({ needsClassification: 0 })
      .where(eq(trackerItems.id, itemId))
      .run();
  }

  const stillPending = db
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(eq(mailMessages.deriveState, "needs_classification"))
    .all().length;

  return { classified, stillPending };
}
