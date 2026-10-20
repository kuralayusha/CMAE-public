/**
 * Thin API-compatible wrapper over lib/sync/engine (Faz 2).
 * Route handlers and UI keep importing from here.
 */
export {
  cancelTrackerSyncSession,
  getActiveSyncSession,
  getSyncSession,
  startTrackerSyncSession,
  subscribeSyncSession,
  syncSessionHello,
  waitForSyncSessionIdle,
  type SyncSession,
  type SyncSessionEvent,
  type SyncSessionPublic,
  type SyncSessionResult,
  type SyncSessionStatus,
} from "@/lib/sync/engine";
