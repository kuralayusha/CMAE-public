import { getDb } from "@/lib/db/client";
import { trackerItems } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { throwIfSyncCanceled } from "./cancel";
import {
  INCREMENTAL_PATCH_MAX,
  patchTrackerWithNewMails,
} from "./incremental";
import { pruneOrphanReadyToSendItems } from "./orphans";
import { reconcilePendingAgainstLiveDrafts } from "./pending-draft";
import { rebuildTrackerItems } from "./rebuild";
import {
  listPendingDeriveMailIds,
  markAllPendingDeriveDone,
  markMailsDeriveState,
  setSyncState,
  syncMailsFromGmail,
  type SyncMode,
} from "./sync";
import type { SyncProgressFn } from "./types";

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

  // Prefer dirty queue over "just inserted" so a failed patch/rebuild retries.
  const pendingIds = listPendingDeriveMailIds();

  const existingRows = getDb().select().from(trackerItems).all().length;
  const canPatch =
    mode === "incremental" &&
    !opts?.skipImap &&
    !skippedImap &&
    existingRows > 0 &&
    pendingIds.length <= INCREMENTAL_PATCH_MAX;

  let itemCount: number;
  try {
    if (canPatch) {
      log?.("think", t("sync.rebuildingListIncremental"));
      const patch = await patchTrackerWithNewMails(pendingIds, {
        onProgress: log,
        signal,
      });
      itemCount = patch.itemCount;
      markMailsDeriveState(pendingIds, "done");
    } else {
      if (mode === "incremental" && pendingIds.length > INCREMENTAL_PATCH_MAX) {
        log?.(
          "system",
          t("sync.incrementalFallbackFull", { count: pendingIds.length }),
        );
      }
      log?.("think", t("sync.rebuildingList"));
      const rebuilt = await rebuildTrackerItems({ onProgress: log, signal });
      itemCount = rebuilt.itemCount;
      markAllPendingDeriveDone();
    }
  } catch (err) {
    // Leave derive_state=pending so the next sync retries these mails.
    const msg = err instanceof Error ? err.message : String(err);
    setSyncState({ lastError: msg });
    throw err;
  }

  throwIfSyncCanceled(signal);
  // Drop pending clock/banner if user deleted the draft in Gmail
  await reconcilePendingAgainstLiveDrafts({ force: true });

  // Folders deleted outside rebuild (or soft-unlinked) leave ghost ready_to_send rows.
  itemCount -= pruneOrphanReadyToSendItems();

  // lastSyncAt only after derivation (+ draft reconcile) finishes.
  setSyncState({
    lastSyncAt: new Date().toISOString(),
    lastError: partial ? partialError : null,
  });

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
