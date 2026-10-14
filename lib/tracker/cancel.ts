export class SyncCanceledError extends Error {
  constructor(message = "Sync canceled") {
    super(message);
    this.name = "SyncCanceledError";
  }
}

export function throwIfSyncCanceled(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new SyncCanceledError();
  }
}
