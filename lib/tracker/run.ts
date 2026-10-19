import { getDb } from "@/lib/db/client";
import { trackerItems } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { throwIfSyncCanceled } from "./cancel";
import {
  INCREMENTAL_PATCH_MAX,
  patchTrackerWithNewMails,
} from "./incremental";
import { rebuildTrackerItems } from "./rebuild";
import { syncMailsFromGmail, type SyncMode } from "./sync";
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
}> {
  const log = opts?.onProgress;
  const signal = opts?.signal;
  const mode: SyncMode = opts?.mode ?? "incremental";
  let skippedImap = Boolean(opts?.skipImap);
  let skipReason: string | undefined;
  let upserted = 0;
  let keptOutsideWindow = 0;
  let insertedIds: number[] = [];

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
    insertedIds = sync.insertedIds;
  } else {
    log?.("think", t("sync.imapSkipped"));
  }

  throwIfSyncCanceled(signal);

  const existingRows = getDb().select().from(trackerItems).all().length;
  const canPatch =
    mode === "incremental" &&
    !opts?.skipImap &&
    !skippedImap &&
    existingRows > 0 &&
    insertedIds.length <= INCREMENTAL_PATCH_MAX;

  let itemCount: number;
  if (canPatch) {
    log?.("think", t("sync.rebuildingListIncremental"));
    const patch = await patchTrackerWithNewMails(insertedIds, {
      onProgress: log,
      signal,
    });
    itemCount = patch.itemCount;
  } else {
    if (mode === "incremental" && insertedIds.length > INCREMENTAL_PATCH_MAX) {
      log?.(
        "system",
        t("sync.incrementalFallbackFull", { count: insertedIds.length }),
      );
    }
    log?.("think", t("sync.rebuildingList"));
    const rebuilt = await rebuildTrackerItems({ onProgress: log, signal });
    itemCount = rebuilt.itemCount;
  }

  throwIfSyncCanceled(signal);
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
  };
}
