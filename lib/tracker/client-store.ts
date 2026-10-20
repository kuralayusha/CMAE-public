"use client";

import { useEffect, useSyncExternalStore } from "react";

export type TrackerStoreSyncMeta = {
  lastSyncAt: string | null;
  lastError: string | null;
  windowDays: number;
};

export type TrackerFreshnessClient = {
  state: string;
  dataAsOf?: string | null;
  lastErrorKind?: string | null;
  lastErrorMessage?: string | null;
  activeIntervalMs?: number;
  messageKey?: string;
  messageParams?: Record<string, string | number>;
};

export type TrackerStoreSnapshot = {
  rev: number;
  etag: string | null;
  sections: unknown[];
  sync: TrackerStoreSyncMeta | null;
  total: number;
  loading: boolean;
  error: string | null;
  serverNow: string | null;
  validUntil: string | null;
  freshness: TrackerFreshnessClient | null;
};

type TrackerClientEvent = {
  type?: string;
  rev?: number;
  itemIds?: number[] | "all";
  itemId?: number;
  fromId?: number;
  intoId?: number;
  freshness?: TrackerFreshnessClient;
};

const empty: TrackerStoreSnapshot = {
  rev: 0,
  etag: null,
  sections: [],
  sync: null,
  total: 0,
  loading: true,
  error: null,
  serverNow: null,
  validUntil: null,
  freshness: null,
};

let snapshot: TrackerStoreSnapshot = empty;
const listeners = new Set<() => void>();
const eventListeners = new Set<(ev: TrackerClientEvent) => void>();
let inflight: Promise<void> | null = null;
let eventsEs: EventSource | null = null;
let eventsRefCount = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Monotonic fetch generation — ignore stale responses. */
let fetchSeq = 0;

function emit() {
  for (const l of listeners) l();
}

function setSnapshot(next: TrackerStoreSnapshot) {
  snapshot = next;
  emit();
}

export function getTrackerStoreSnapshot(): TrackerStoreSnapshot {
  return snapshot;
}

export function subscribeTrackerStore(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

/**
 * Apply a list payload only if rev is newer (or unknown).
 * Used after sync stream / bulk responses that include sections.
 */
export function applyTrackerListPayload(data: {
  sections?: unknown[];
  sync?: TrackerStoreSyncMeta | null;
  total?: number;
  rev?: number;
  etag?: string | null;
  serverNow?: string | null;
  validUntil?: string | null;
  freshness?: TrackerFreshnessClient | null;
}): boolean {
  if (typeof data.rev === "number" && data.rev < snapshot.rev) {
    return false;
  }
  setSnapshot({
    ...snapshot,
    rev: typeof data.rev === "number" ? data.rev : snapshot.rev,
    etag: data.etag !== undefined ? data.etag : snapshot.etag,
    sections: data.sections ?? snapshot.sections,
    sync: data.sync !== undefined ? data.sync : snapshot.sync,
    total: typeof data.total === "number" ? data.total : snapshot.total,
    loading: false,
    error: null,
    serverNow:
      data.serverNow !== undefined ? data.serverNow : snapshot.serverNow,
    validUntil:
      data.validUntil !== undefined ? data.validUntil : snapshot.validUntil,
    freshness:
      data.freshness !== undefined ? data.freshness : snapshot.freshness,
  });
  return true;
}

function nudgeServer(body: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  void fetch("/api/tracker/sync/nudge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {
    /* ignore */
  });
}

export async function refreshTrackerList(opts?: {
  force?: boolean;
}): Promise<void> {
  if (inflight) return inflight;

  const seq = ++fetchSeq;
  const force = Boolean(opts?.force);

  inflight = (async () => {
    try {
      const headers: Record<string, string> = {};
      if (!force && snapshot.etag) {
        headers["If-None-Match"] = snapshot.etag;
      }
      const res = await fetch("/api/tracker", { headers });
      if (seq !== fetchSeq) return;

      if (res.status === 304) {
        const etag = res.headers.get("ETag");
        if (etag && etag !== snapshot.etag) {
          setSnapshot({ ...snapshot, etag, loading: false, error: null });
        } else if (snapshot.loading) {
          setSnapshot({ ...snapshot, loading: false });
        }
        return;
      }

      const data = (await res.json()) as {
        error?: string;
        sections?: unknown[];
        sync?: TrackerStoreSyncMeta | null;
        total?: number;
        rev?: number;
        serverNow?: string;
        validUntil?: string;
        freshness?: TrackerFreshnessClient | null;
      };
      if (seq !== fetchSeq) return;

      if (!res.ok) {
        setSnapshot({
          ...snapshot,
          loading: false,
          error: data.error || "Failed to load tracker",
        });
        return;
      }

      const rev = typeof data.rev === "number" ? data.rev : snapshot.rev;
      if (rev < snapshot.rev) return;

      setSnapshot({
        rev,
        etag: res.headers.get("ETag"),
        sections: data.sections || [],
        sync: data.sync ?? null,
        total: data.total || 0,
        loading: false,
        error: null,
        serverNow: data.serverNow ?? null,
        validUntil: data.validUntil ?? null,
        freshness: data.freshness ?? snapshot.freshness,
      });
    } catch (err) {
      if (seq !== fetchSeq) return;
      setSnapshot({
        ...snapshot,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })().finally(() => {
    if (inflight) inflight = null;
  });

  return inflight;
}

function startStalePoll() {
  if (pollTimer || typeof window === "undefined") return;
  pollTimer = setInterval(() => {
    if (document.visibilityState === "hidden") return;
    if (eventsEs && eventsEs.readyState === EventSource.OPEN) return;
    void refreshTrackerList().catch(() => {
      /* keep prior */
    });
  }, 30_000);
}

function stopStalePoll() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function dispatchClientEvent(data: TrackerClientEvent) {
  for (const l of eventListeners) l(data);

  if (data.type === "freshness" && data.freshness) {
    setSnapshot({ ...snapshot, freshness: data.freshness });
    return;
  }

  if (data.type === "hello" && typeof data.rev === "number") {
    if (data.freshness) {
      setSnapshot({ ...snapshot, freshness: data.freshness });
    }
    if (data.rev > snapshot.rev) {
      void refreshTrackerList({ force: true });
    } else {
      void refreshTrackerList();
    }
    return;
  }
  if (data.type === "reset") {
    void refreshTrackerList({ force: true });
    return;
  }
  if (data.type === "job") {
    void refreshTrackerList();
    return;
  }
  if (
    data.type === "changed" ||
    data.type === "research_merged" ||
    data.type === "refresh" ||
    data.type === "merged" ||
    data.type === "deleted"
  ) {
    void refreshTrackerList();
  }
}

function onTrackerEventMessage(ev: MessageEvent) {
  try {
    dispatchClientEvent(JSON.parse(ev.data) as TrackerClientEvent);
  } catch {
    /* ignore malformed */
  }
}

/** Ref-counted SSE to /api/tracker/events. */
export function retainTrackerEvents(): () => void {
  eventsRefCount += 1;
  if (!eventsEs && typeof window !== "undefined") {
    const es = new EventSource("/api/tracker/events");
    eventsEs = es;
    es.onmessage = onTrackerEventMessage;
    es.onerror = () => {
      startStalePoll();
    };
    es.onopen = () => {
      stopStalePoll();
    };
  }
  return () => {
    eventsRefCount = Math.max(0, eventsRefCount - 1);
    if (eventsRefCount === 0 && eventsEs) {
      eventsEs.close();
      eventsEs = null;
      stopStalePoll();
    }
  };
}

export function subscribeTrackerClientEvents(
  listener: (ev: TrackerClientEvent) => void,
): () => void {
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

export function useTrackerListStore(): TrackerStoreSnapshot {
  return useSyncExternalStore(
    subscribeTrackerStore,
    getTrackerStoreSnapshot,
    getTrackerStoreSnapshot,
  );
}

/** Mount helper: initial load + SSE + focus/visibility conditional refresh. */
export function useTrackerListSync(opts?: { enabled?: boolean }) {
  const enabled = opts?.enabled !== false;
  const snap = useTrackerListStore();

  useEffect(() => {
    if (!enabled) return;
    void refreshTrackerList({ force: true });
    const release = retainTrackerEvents();

    const onVis = () => {
      const visible = document.visibilityState === "visible";
      nudgeServer({
        visibility: visible ? "visible" : "hidden",
        reason: visible ? "focus" : undefined,
      });
      if (!visible) return;
      void refreshTrackerList().catch(() => {
        /* keep prior */
      });
    };
    const onOnline = () => {
      nudgeServer({ reason: "online" });
      void refreshTrackerList().catch(() => {
        /* keep prior */
      });
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    window.addEventListener("online", onOnline);
    nudgeServer({
      visibility:
        document.visibilityState === "visible" ? "visible" : "hidden",
    });

    return () => {
      release();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
      window.removeEventListener("online", onOnline);
    };
  }, [enabled]);

  return snap;
}

/** Detail page: reload when this item (or global) changes. */
export function useTrackerItemEvents(
  itemId: number,
  onRelevant: () => void,
): void {
  useEffect(() => {
    const release = retainTrackerEvents();
    const unsub = subscribeTrackerClientEvents((data) => {
      if (data.type === "reset" || data.type === "refresh") {
        onRelevant();
        return;
      }
      if (data.type === "changed") {
        if (
          data.itemIds === "all" ||
          !data.itemIds ||
          data.itemIds.includes(itemId)
        ) {
          onRelevant();
        }
        return;
      }
      if (
        data.type === "research_merged" &&
        (data.itemId == null || data.itemId === itemId)
      ) {
        onRelevant();
        return;
      }
      if (
        data.type === "merged" &&
        (data.fromId === itemId || data.intoId === itemId)
      ) {
        onRelevant();
        return;
      }
      if (data.type === "deleted" && data.itemId === itemId) {
        onRelevant();
      }
    });
    return () => {
      unsub();
      release();
    };
  }, [itemId, onRelevant]);
}
