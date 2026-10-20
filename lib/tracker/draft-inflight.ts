/**
 * In-memory counter for long-running tracker draft ops (prepare .md / Gmail draft).
 * Survives across route handlers in the same Node process; used so Settings can
 * lock while a prepare/draft request is still in flight after navigating away.
 */

declare global {
  // eslint-disable-next-line no-var
  var __cmaeDraftInflight: number | undefined;
}

export function beginDraftOperation(): void {
  globalThis.__cmaeDraftInflight = (globalThis.__cmaeDraftInflight ?? 0) + 1;
}

export function endDraftOperation(): void {
  const next = (globalThis.__cmaeDraftInflight ?? 0) - 1;
  globalThis.__cmaeDraftInflight = next > 0 ? next : 0;
}

export function getDraftInflightCount(): number {
  return globalThis.__cmaeDraftInflight ?? 0;
}
