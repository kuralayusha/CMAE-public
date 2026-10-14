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
    mode === "hard" ? "Tracker Hard Sync başladı" : "Tracker sync başladı",
  );

  if (!opts?.skipImap) {
    const sync = await syncMailsFromGmail({ mode, onProgress: log, signal });
    skippedImap = sync.skipped;
    skipReason = sync.reason;
    upserted = sync.upserted;
    keptOutsideWindow = sync.keptOutsideWindow;
  } else {
    log?.("think", "IMAP atlandı (skipImap)");
  }

  throwIfSyncCanceled(signal);
  log?.("think", "Liste yeniden kuruluyor (mail + workspace + AI)…");
  const { itemCount } = await rebuildTrackerItems({ onProgress: log, signal });
  throwIfSyncCanceled(signal);
  log?.("ok", `Sync tamam · ${upserted} mail · ${itemCount} satır`);
  return {
    skippedImap,
    skipReason,
    upserted,
    itemCount,
    mode,
    keptOutsideWindow,
  };
}
