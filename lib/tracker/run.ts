import { t } from "@/lib/i18n/t";
import { throwIfSyncCanceled } from "./cancel";
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
  } else {
    log?.("think", t("sync.imapSkipped"));
  }

  throwIfSyncCanceled(signal);
  log?.("think", t("sync.rebuildingList"));
  const { itemCount } = await rebuildTrackerItems({ onProgress: log, signal });
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
