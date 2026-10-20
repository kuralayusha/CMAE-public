import { bumpAppMetaInt } from "@/lib/db/app-meta";

declare global {
  // eslint-disable-next-line no-var
  var __cmaeSyncAuthBlockedCreds: number | undefined;
  // eslint-disable-next-line no-var
  var __cmaeSyncNotifyAuthChange: (() => void) | undefined;
}

/** Clear auth block and bump credentials_version; notify scheduler. */
export function notifyCredentialsChanged(): void {
  bumpAppMetaInt("credentials_version");
  globalThis.__cmaeSyncAuthBlockedCreds = undefined;
  globalThis.__cmaeSyncNotifyAuthChange?.();
}

export function markAuthBlocked(credentialsVersion: number): void {
  globalThis.__cmaeSyncAuthBlockedCreds = credentialsVersion;
}

export function isAutoSyncBlockedByAuth(
  currentCredentialsVersion: number,
): boolean {
  const blocked = globalThis.__cmaeSyncAuthBlockedCreds;
  if (blocked == null) return false;
  if (currentCredentialsVersion !== blocked) {
    globalThis.__cmaeSyncAuthBlockedCreds = undefined;
    return false;
  }
  return true;
}
