import { t } from "@/lib/i18n/t";

export class SyncCanceledError extends Error {
  constructor(message = t("sync.canceled")) {
    super(message);
    this.name = "SyncCanceledError";
  }
}

export function throwIfSyncCanceled(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new SyncCanceledError();
  }
}
