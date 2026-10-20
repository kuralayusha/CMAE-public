/**
 * Legacy live bus — forwards to the revision-aware events bus.
 * Prefer bumpTrackerRevision / emitTrackerEvent for new code.
 */
import {
  emitTrackerEvent,
  subscribeTrackerEvents,
  type TrackerEvent,
} from "./events-bus";

export type TrackerLiveEvent = {
  type: "research_merged" | "refresh";
  researchJobId?: string;
  action?: "inserted" | "updated" | "linked" | "skipped";
  itemId?: number;
  at?: number;
};

export function emitTrackerLive(event: TrackerLiveEvent) {
  const at = Date.now();
  if (event.type === "research_merged") {
    emitTrackerEvent({
      type: "research_merged",
      researchJobId: event.researchJobId,
      action: event.action,
      itemId: event.itemId,
      at,
    });
  } else {
    emitTrackerEvent({ type: "refresh", at });
  }
}

export function subscribeTrackerLive(
  listener: (event: TrackerLiveEvent) => void,
): () => void {
  return subscribeTrackerEvents((event: TrackerEvent) => {
    if (event.type === "research_merged") {
      listener({
        type: "research_merged",
        researchJobId: event.researchJobId,
        action: event.action,
        itemId: event.itemId,
        at: event.at,
      });
    } else if (event.type === "refresh" || event.type === "changed") {
      listener({ type: "refresh", at: Date.now() });
    }
  });
}
