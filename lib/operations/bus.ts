import "server-only";

import { getOperationsStatus, type OperationsStatus } from "./status";

/**
 * In-process pub/sub for operations status (sync / research / draft).
 * A tiny in-memory watcher (1s, no DB / network) runs only while at least one
 * subscriber exists and emits only when the status actually changed.
 * notifyOperationsChanged() gives instant reaction; the watcher is a safety net.
 */

type Listener = (status: OperationsStatus) => void;

type BusState = {
  listeners: Set<Listener>;
  timer: ReturnType<typeof setInterval> | null;
  lastKey: string | null;
};

declare global {
  var __cmaeOpsBus: BusState | undefined;
}

const WATCH_MS = 1000;

function state(): BusState {
  if (!globalThis.__cmaeOpsBus) {
    globalThis.__cmaeOpsBus = { listeners: new Set(), timer: null, lastKey: null };
  }
  return globalThis.__cmaeOpsBus;
}

function keyOf(s: OperationsStatus): string {
  return `${s.gmailSync ? 1 : 0}${s.research ? 1 : 0}${s.trackerDraft ? 1 : 0}`;
}

function check(): void {
  const st = state();
  if (!st.listeners.size) return;
  let status: OperationsStatus;
  try {
    status = getOperationsStatus();
  } catch {
    return;
  }
  const key = keyOf(status);
  if (key === st.lastKey) return;
  st.lastKey = key;
  for (const l of [...st.listeners]) {
    try {
      l(status);
    } catch {
      /* listener errors must not break others */
    }
  }
}

/** Cheap call-site hook: re-evaluates status now and emits if changed. */
export function notifyOperationsChanged(): void {
  check();
}

export function subscribeOperations(listener: Listener): () => void {
  const st = state();
  st.listeners.add(listener);
  if (!st.timer) {
    st.lastKey = null;
    st.timer = setInterval(check, WATCH_MS);
    if (typeof st.timer === "object" && "unref" in st.timer) st.timer.unref();
  }
  // Seed lastKey so the first change after subscribe is emitted.
  try {
    const cur = getOperationsStatus();
    if (st.lastKey === null) st.lastKey = keyOf(cur);
  } catch {
    /* ignore */
  }
  return () => {
    st.listeners.delete(listener);
    if (!st.listeners.size && st.timer) {
      clearInterval(st.timer);
      st.timer = null;
      st.lastKey = null;
    }
  };
}
