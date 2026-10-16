import { EventEmitter } from "events";

export type TrackerLiveEvent = {
  type: "research_merged" | "refresh";
  researchJobId?: string;
  action?: "inserted" | "updated" | "linked" | "skipped";
  itemId?: number;
  at?: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __cmaeTrackerLiveBus: EventEmitter | undefined;
}

export function getTrackerLiveBus(): EventEmitter {
  if (!globalThis.__cmaeTrackerLiveBus) {
    globalThis.__cmaeTrackerLiveBus = new EventEmitter();
    globalThis.__cmaeTrackerLiveBus.setMaxListeners(100);
  }
  return globalThis.__cmaeTrackerLiveBus;
}

export function emitTrackerLive(event: TrackerLiveEvent) {
  getTrackerLiveBus().emit("live", { ...event, at: Date.now() });
}

export function subscribeTrackerLive(
  listener: (event: TrackerLiveEvent) => void,
): () => void {
  const bus = getTrackerLiveBus();
  bus.on("live", listener);
  return () => {
    bus.off("live", listener);
  };
}
