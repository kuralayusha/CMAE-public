import { EventEmitter } from "events";
import { getSqlite } from "@/lib/db/client";

export type TrackerFreshness = {
  /** Minimal stub until Faz 2 freshness calculator. */
  state: "unknown" | "fresh" | "syncing" | "stale_offline" | "never_synced";
};

export type TrackerEvent =
  | {
      type: "hello";
      rev: number;
      serverNow: string;
      freshness: TrackerFreshness;
    }
  | {
      type: "changed";
      rev: number;
      itemIds: number[] | "all";
      source: string;
    }
  | {
      type: "merged";
      rev: number;
      fromId: number;
      intoId: number;
    }
  | {
      type: "deleted";
      rev: number;
      itemId: number;
      reason: string;
    }
  | {
      type: "job";
      jobId: string;
      kind: string;
      state: string;
      phase?: string;
      progress?: { done: number; total: number };
    }
  | { type: "freshness"; freshness: TrackerFreshness }
  | { type: "tick"; reason: "time_transition" }
  | { type: "reset"; rev: number }
  | { type: "ping" }
  /** Legacy live events (research merge) — clients may still listen. */
  | {
      type: "research_merged";
      rev?: number;
      researchJobId?: string;
      action?: "inserted" | "updated" | "linked" | "skipped";
      itemId?: number;
      at?: number;
    }
  | { type: "refresh"; rev?: number; at?: number };

declare global {
  // eslint-disable-next-line no-var
  var __cmaeTrackerEventsBus: EventEmitter | undefined;
  // eslint-disable-next-line no-var
  var __cmaeTrackerDataVersionPoller: {
    timer: ReturnType<typeof setInterval> | null;
    lastVersion: number | null;
    subscribers: number;
  } | undefined;
}

function getBus(): EventEmitter {
  if (!globalThis.__cmaeTrackerEventsBus) {
    globalThis.__cmaeTrackerEventsBus = new EventEmitter();
    globalThis.__cmaeTrackerEventsBus.setMaxListeners(200);
  }
  return globalThis.__cmaeTrackerEventsBus;
}

function pollerState() {
  if (!globalThis.__cmaeTrackerDataVersionPoller) {
    globalThis.__cmaeTrackerDataVersionPoller = {
      timer: null,
      lastVersion: null,
      subscribers: 0,
    };
  }
  return globalThis.__cmaeTrackerDataVersionPoller;
}

function readDataVersion(): number {
  try {
    const row = getSqlite().pragma("data_version", { simple: true }) as
      | number
      | string;
    return typeof row === "number" ? row : Number.parseInt(String(row), 10) || 0;
  } catch {
    return 0;
  }
}

function readRevision(): number {
  try {
    const row = getSqlite()
      .prepare(`SELECT value FROM app_meta WHERE key = 'tracker_revision'`)
      .get() as { value: string } | undefined;
    if (!row) return 0;
    const n = Number.parseInt(row.value, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function ensureDataVersionPoller() {
  const state = pollerState();
  if (state.timer) return;
  state.lastVersion = readDataVersion();
  state.timer = setInterval(() => {
    const v = readDataVersion();
    if (state.lastVersion == null) {
      state.lastVersion = v;
      return;
    }
    if (v === state.lastVersion) return;
    state.lastVersion = v;
    const rev = readRevision();
    emitTrackerEvent({
      type: "changed",
      rev,
      itemIds: "all",
      source: "data_version",
    });
  }, 1000);
  if (typeof state.timer === "object" && "unref" in state.timer) {
    state.timer.unref();
  }
}

function stopDataVersionPollerIfIdle() {
  const state = pollerState();
  if (state.subscribers > 0 || !state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
}

export function emitTrackerEvent(event: TrackerEvent) {
  getBus().emit("event", event);
}

export function notifyTrackerRevision(info: {
  rev: number;
  source: string;
  kind: string;
  itemIds: number[] | "all";
}) {
  const state = pollerState();
  try {
    state.lastVersion = readDataVersion();
  } catch {
    /* db may be closing */
  }
  const itemIds =
    info.itemIds === "all" || info.itemIds.length === 0 ? "all" : info.itemIds;
  emitTrackerEvent({
    type: "changed",
    rev: info.rev,
    itemIds,
    source: info.source,
  });
}

export function subscribeTrackerEvents(
  listener: (event: TrackerEvent) => void,
): () => void {
  const bus = getBus();
  const state = pollerState();
  state.subscribers += 1;
  ensureDataVersionPoller();
  bus.on("event", listener);
  return () => {
    bus.off("event", listener);
    state.subscribers = Math.max(0, state.subscribers - 1);
    stopDataVersionPollerIfIdle();
  };
}

/** Backfill changed events after Last-Event-ID, or signal reset. */
export function backfillTrackerEvents(lastEventId: number): TrackerEvent[] {
  const rev = readRevision();
  if (!Number.isFinite(lastEventId) || lastEventId < 0) {
    return [{ type: "reset", rev }];
  }
  if (lastEventId >= rev) return [];

  let changes: {
    rev: number;
    source: string;
    itemIds: number[];
  }[] = [];
  try {
    const rows = getSqlite()
      .prepare(
        `SELECT rev, source, item_ids AS itemIds
         FROM tracker_changes
         WHERE rev > ?
         ORDER BY rev ASC`,
      )
      .all(lastEventId) as { rev: number; source: string; itemIds: string }[];
    changes = rows.map((r) => {
      let itemIds: number[] = [];
      try {
        const parsed = JSON.parse(r.itemIds) as unknown;
        if (Array.isArray(parsed)) {
          itemIds = parsed.filter((x): x is number => typeof x === "number");
        }
      } catch {
        itemIds = [];
      }
      return { rev: r.rev, source: r.source, itemIds };
    });
  } catch {
    return [{ type: "reset", rev }];
  }

  if (!changes.length) {
    return [{ type: "reset", rev }];
  }
  const oldest = changes[0]!.rev;
  if (oldest > lastEventId + 1) {
    return [{ type: "reset", rev }];
  }

  return changes.map((c) => ({
    type: "changed" as const,
    rev: c.rev,
    itemIds: c.itemIds.length ? c.itemIds : ("all" as const),
    source: c.source,
  }));
}

export function trackerHelloEvent(): Extract<TrackerEvent, { type: "hello" }> {
  return {
    type: "hello",
    rev: readRevision(),
    serverNow: new Date().toISOString(),
    freshness: { state: "unknown" },
  };
}
