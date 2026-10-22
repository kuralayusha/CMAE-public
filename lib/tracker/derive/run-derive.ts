/**
 * Sync derivation (architecture §2.6.5–§2.6.10): dirty derive_state queue →
 * stage 0 structural attach → conversation AI stages (triage, identity,
 * events) → facts. Hard mode re-runs every conversation through AI (cache
 * ignored), like a first sync; rows are kept and re-attached, not wiped.
 */

import { eq, inArray } from "drizzle-orm";
import { getAppMeta, setAppMeta } from "@/lib/db/app-meta";
import { getDb, getSqlite } from "@/lib/db/client";
import { mailMessages, mailUnassigned, trackerItems } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { getSettingsRow } from "@/lib/settings/service";
import { DEFAULT_FOLLOW_UP_DAYS } from "../status-constants";
import { throwIfSyncCanceled } from "../cancel";
import { normalizeMailText } from "../signals";
import type { MailIntentMap } from "../mail-kind";
import type { SyncProgressFn } from "../types";
import { drainAmbiguousRoutingSkips, tryRuleBasedAssign } from "./assign";
import { attachConversationMails } from "./conversations";
import { resolveIntentFast } from "./intent";
import { suggestTwinMerges } from "./merge-suggestions";
import { parseAutoFlags } from "./noise";
import { noteRecentItem } from "../recent";
import { refreshItemFacts } from "./refresh-item";
import { runConversationStages, type StageMode } from "./stages";

/** Architecture: process dirty queue in chunks of 200; no 25-mail full-rebuild threshold. */
export const DERIVE_CHUNK_SIZE = 200;

/** One-shot: recompute every item once so events_json (stage 4 input) exists. */
const EVENTS_BACKFILL_META = "derive_events_timeline_v1";

function liveItemIds(): number[] {
  return getDb()
    .select({ id: trackerItems.id, deletedAt: trackerItems.deletedAt })
    .from(trackerItems)
    .all()
    .filter((i) => !i.deletedAt)
    .map((i) => i.id);
}

/**
 * Stage 0 repair (architecture §2.6.5): attach unassigned mails (SENT
 * included) of conversations that already belong to an item. Also re-tries
 * `mail_unassigned(unmatched_outbound)`.
 */
function repairConversations(touched: Set<number>): number {
  const before = touched.size;
  for (const id of attachConversationMails()) touched.add(id);
  if (getAppMeta(EVENTS_BACKFILL_META, getSqlite()) !== "1") {
    for (const id of liveItemIds()) touched.add(id);
    setAppMeta(EVENTS_BACKFILL_META, "1", getSqlite());
  }
  return touched.size - before;
}

function markDeriveState(
  mailIds: number[],
  state: "done" | "noise" | "needs_classification" | "pending",
): void {
  if (!mailIds.length) return;
  const db = getDb();
  for (const id of mailIds) {
    db.update(mailMessages)
      .set({ deriveState: state })
      .where(eq(mailMessages.id, id))
      .run();
  }
}

export async function derivePendingMails(
  pendingIds: number[],
  opts?: {
    mode?: StageMode;
    onProgress?: SyncProgressFn;
    signal?: AbortSignal;
  },
): Promise<{
  itemCount: number;
  attached: number;
  created: number;
  skipped: number;
  unassigned: number;
}> {
  const log = opts?.onProgress;
  const signal = opts?.signal;
  const mode = opts?.mode ?? "incremental";
  // Never hold a drizzle handle across IMAP/LLM awaits (onboarding reconcile
  // / path flip can closeDb mid-job).
  let db = getDb();
  const settings = getSettingsRow();
  const followUpDays = settings?.followUpDays ?? DEFAULT_FOLLOW_UP_DAYS;
  const userEmail = (settings?.gmailAddress || "").toLowerCase();

  // Older builds parked AI `skip` as unassigned(ambiguous) — drain to noise
  // so the freshness banner only reflects actionable review queues.
  drainAmbiguousRoutingSkips();

  const touched = new Set<number>();
  repairConversations(touched);

  // Unsent Gmail drafts (All Mail `\Draft`) were once counted as sent mail —
  // re-derive any item still carrying one so its status recovers.
  for (const r of getSqlite()
    .prepare(
      `SELECT DISTINCT ma.item_id AS itemId
         FROM mail_assignments ma
         JOIN mail_messages mm ON mm.id = ma.mail_id
        WHERE mm.labels_json LIKE '%Draft%'
          AND mm.labels_json NOT LIKE '%Sent%'`,
    )
    .all() as { itemId: number }[]) {
    touched.add(r.itemId);
  }

  if (!pendingIds.length && mode !== "hard") {
    for (const itemId of touched) {
      refreshItemFacts(itemId, new Map(), followUpDays);
    }
    log?.("ok", t("sync.incrementalNoNew"));
    return {
      itemCount: liveItemIds().length,
      attached: 0,
      created: 0,
      skipped: 0,
      unassigned: 0,
    };
  }

  throwIfSyncCanceled(signal);

  let attached = 0;
  let skipped = 0;
  const allIntents: MailIntentMap = new Map();

  // Stage 0 (§2.6.5): structural attach only — reply headers / thread id.
  // Everything else is decided per conversation by the AI stages below.
  for (let i = 0; i < pendingIds.length; i += DERIVE_CHUNK_SIZE) {
    const chunkIds = pendingIds.slice(i, i + DERIVE_CHUNK_SIZE);
    throwIfSyncCanceled(signal);
    db = getDb();
    const newMails = db
      .select()
      .from(mailMessages)
      .where(inArray(mailMessages.id, chunkIds))
      .all();
    log?.("think", t("sync.incrementalStart", { count: newMails.length }));

    for (const mail of newMails) {
      const flags = parseAutoFlags(mail.autoFlags);
      if (flags && !flags.bounce && (flags.listId || flags.bulk)) {
        skipped += 1;
        markDeriveState([mail.id], "noise");
        continue;
      }
      // Provisional intent (header / cache / regex): only used for the
      // timeline when stage 3 has no AI events yet (shown as unverified).
      const intentResult = resolveIntentFast({
        mailId: mail.id,
        subject: mail.subject,
        body: normalizeMailText(mail.bodyText || mail.snippet || ""),
        fromAddr: mail.fromAddr,
        toAddr: mail.toAddr,
        autoFlagsRaw: mail.autoFlags,
      });
      allIntents.set(mail.id, intentResult.record);
      const deferForBody = mail.bodyState === "failed";

      const rule = tryRuleBasedAssign(mail, userEmail, { structuralOnly: true });
      if (rule.kind === "assigned" || rule.kind === "already") {
        if (rule.kind === "assigned") {
          attached += 1;
          if (mode !== "hard") {
            noteRecentItem(rule.itemId, "mail_attached", {
              detail: { source: "thread", mailId: mail.id },
            });
          }
        }
        touched.add(rule.itemId);
      }
      markDeriveState([mail.id], deferForBody ? "pending" : "done");
    }
  }
  repairConversations(touched);

  const stats = await runConversationStages({
    mode,
    dirtyMailIds: new Set(pendingIds),
    touched,
    userEmail,
    onProgress: log,
    signal,
  });
  throwIfSyncCanceled(signal);
  repairConversations(touched);

  for (const itemId of touched) {
    refreshItemFacts(itemId, allIntents, followUpDays, {
      needsClassification: false,
    });
  }

  // Soft twin suggestions only (K3) — never auto-merge.
  const proposals = suggestTwinMerges(stats.duplicatePairs);
  if (proposals > 0) {
    log?.("system", t("sync.collapsedTwins", { count: proposals }));
  }

  const itemCount = liveItemIds().length;
  const unassigned = getDb().select().from(mailUnassigned).all().length;
  log?.(
    "ok",
    t("sync.incrementalDone", {
      attached: attached + stats.attached,
      created: stats.created,
      skipped: skipped + stats.noiseConversations,
      rows: itemCount,
    }),
  );

  return {
    itemCount,
    attached: attached + stats.attached,
    created: stats.created,
    skipped: skipped + stats.noiseConversations,
    unassigned,
  };
}
