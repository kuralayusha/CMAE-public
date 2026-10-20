import { getDb } from "@/lib/db/client";
import { bumpTrackerRevision } from "@/lib/db/revision";
import { trackerItems } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { throwIfSyncCanceled } from "./cancel";
import { runClassifyRetry } from "./derive/classify-retry";
import { derivePendingMails } from "./derive/run-derive";
import { pruneOrphanReadyToSendItems } from "./orphans";
import { reconcilePendingAgainstLiveDrafts } from "./pending-draft";
import { rebuildTrackerItems } from "./rebuild";
import {
  listPendingDeriveMailIds,
  markMailsDeriveState,
  setSyncState,
  syncMailsFromGmail,
  type SyncMode,
} from "./sync";
import type { SyncProgressFn } from "./types";
import { getSqlite } from "@/lib/db/client";

export async function runTrackerSync(opts?: {
  skipImap?: boolean;
  mode?: SyncMode;
  onProgress?: SyncProgressFn;
  signal?: AbortSignal;
}): Promise<{
  skippedImap: boolean;
  skipReason?: string;
  upserted: number;
  itemCount: number;
  mode: SyncMode;
  keptOutsideWindow: number;
  partial: boolean;
}> {
  const log = opts?.onProgress;
  const signal = opts?.signal;
  const mode: SyncMode = opts?.mode ?? "incremental";
  let skippedImap = Boolean(opts?.skipImap);
  let skipReason: string | undefined;
  let upserted = 0;
  let keptOutsideWindow = 0;
  let partial = false;
  let partialError: string | null = null;

  throwIfSyncCanceled(signal);
  log?.(
    "system",
    mode === "hard" ? t("sync.hardStarted") : t("sync.started"),
  );

  if (!opts?.skipImap) {
    const sync = await syncMailsFromGmail({ mode, onProgress: log, signal });
    skippedImap = sync.skipped;
    skipReason = sync.reason;
    upserted = sync.upserted;
    keptOutsideWindow = sync.keptOutsideWindow;
    partial = sync.partial;
    partialError = sync.partialError;
  } else {
    log?.("think", t("sync.imapSkipped"));
  }

  throwIfSyncCanceled(signal);

  const pendingIds = listPendingDeriveMailIds();
  const existingRows = getDb()
    .select()
    .from(trackerItems)
    .all()
    .filter((r) => !r.deletedAt).length;

  let itemCount: number;
  try {
    if (mode === "hard") {
      // Explicit full regroup (stable-id diff) — not the normal path.
      log?.("think", t("sync.rebuildingList"));
      const rebuilt = await rebuildTrackerItems({ onProgress: log, signal });
      itemCount = rebuilt.itemCount;
      if (pendingIds.length) {
        markMailsDeriveState(pendingIds, "done");
      }
    } else {
      // Faz 4: always incremental via dirty queue — no 25-mail rebuild threshold.
      if (existingRows === 0 && pendingIds.length === 0) {
        log?.("ok", t("sync.incrementalNoNew"));
        itemCount = 0;
      } else {
        log?.("think", t("sync.rebuildingListIncremental"));
        const derived = await derivePendingMails(pendingIds, {
          onProgress: log,
          signal,
        });
        itemCount = derived.itemCount;
      }
    }
  } catch (err) {
    // Leave derive_state=pending so the next sync retries these mails.
    const msg = err instanceof Error ? err.message : String(err);
    setSyncState({ lastError: msg });
    throw err;
  }

  throwIfSyncCanceled(signal);

  // classify_retry: upgrade provisional regex intents (best-effort; failures leave queue).
  try {
    const needsClass = getSqlite()
      .prepare(
        `SELECT COUNT(*) AS n FROM mail_messages WHERE derive_state = 'needs_classification'`,
      )
      .get() as { n: number };
    if (needsClass?.n > 0) {
      await runClassifyRetry({ onProgress: log, signal });
    }
  } catch {
    // Backoff via next sync / dedicated classify_retry job (engine scaffold).
  }

  await reconcilePendingAgainstLiveDrafts({ force: true });

  itemCount -= pruneOrphanReadyToSendItems();

  setSyncState({
    lastSyncAt: new Date().toISOString(),
    lastError: partial ? partialError : null,
  });
  bumpTrackerRevision("sync", "global", "all");

  log?.(
    "ok",
    t("sync.complete", { mails: upserted, rows: itemCount }),
  );
  return {
    skippedImap,
    skipReason,
    upserted,
    itemCount,
    mode,
    keptOutsideWindow,
    partial,
  };
}
