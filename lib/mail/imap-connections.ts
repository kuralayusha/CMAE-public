/**
 * Process-wide IMAP connection counter (sync/drafts + IDLE ≤ 2).
 */

declare global {
  // eslint-disable-next-line no-var
  var __cmaeImapConnCount: number | undefined;
}

export function getImapConnectionCount(): number {
  return globalThis.__cmaeImapConnCount ?? 0;
}

export function trackImapConnection(delta: 1 | -1): void {
  const next = Math.max(0, (globalThis.__cmaeImapConnCount ?? 0) + delta);
  globalThis.__cmaeImapConnCount = next;
}
