/**
 * Stage 4 — computed-on-read status from the per-mail event timeline + user
 * overlay + clock + settings (architecture §2.6.9). Pure: pass `now` for
 * fake-clock tests / transitions without sync.
 *
 * Rules:
 * - rejection → `rejected`; a later thanks_sent closes immediately; silence
 *   closes after `rejectionCloseDays`; a new application / question or a
 *   non-rejection inbound (invite, request, offer) continues the process.
 * - withdrawn → closed.
 * - interview_invite / info_request / offer after the last outbound → needs_reply;
 *   action_required / assessment → needs_action (closes when stale).
 * - ooo with a return date → waiting until end of that day.
 * - otherwise silence: follow_up_due after followUpDays (7-day cooldown once a
 *   follow-up was sent) from the last outbound (or the last ack / inbound when
 *   nothing was sent by mail); `staleCloseDays` after that anchor → closed.
 */

import { endOfDayUtc, nextBusinessDayAfter } from "../signals";
import {
  DEFAULT_REJECTION_CLOSE_DAYS,
  DEFAULT_STALE_CLOSE_DAYS,
  followUpSilenceDays,
} from "../status-constants";
import type { TrackerSentiment, TrackerStatus, WaitingOn } from "../types";
import {
  eventFromIntent,
  NEEDS_ACTION_EVENTS,
  NEEDS_REPLY_EVENTS,
  parseTimeline,
  type EventTimelineEntry,
} from "./events";
import type { ItemFacts } from "./facts";
import { parseFlagsJson } from "./flags";

export type EffectiveInput = {
  facts: ItemFacts;
  userState: "active" | "inactive" | "dismissed" | string;
  followUpDays: number;
  rejectionCloseDays?: number;
  staleCloseDays?: number;
  now?: number;
};

export type EffectiveResult = {
  status: TrackerStatus;
  sentiment: TrackerSentiment | null;
  waitingOn: WaitingOn | null;
  nextFollowUpAt: string | null;
  /** When the computed status changes next without new mail (clock only). */
  nextTransitionAt: string | null;
  ignored: boolean;
  waitingUntil: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function plusDays(iso: string, days: number): number {
  return Date.parse(iso) + days * DAY_MS;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function result(
  status: TrackerStatus,
  extra: Partial<Omit<EffectiveResult, "status">> = {},
): EffectiveResult {
  return {
    status,
    sentiment: null,
    waitingOn: null,
    nextFollowUpAt: null,
    nextTransitionAt: null,
    ignored: false,
    waitingUntil: null,
    ...extra,
  };
}

type MachineState = {
  closedByUs: boolean;
  rejectedAt: string | null;
  lastOut: EventTimelineEntry | null;
  pending: EventTimelineEntry | null;
  /** Last ack / auto_ack since the last outbound (silence anchor without outbound). */
  lastAck: EventTimelineEntry | null;
  /** Last inbound of any kind since the last outbound (fallback anchor). */
  lastIn: EventTimelineEntry | null;
  ooo: EventTimelineEntry | null;
  trailingFollowUps: number;
};

/** Pure fold over the chronological timeline. */
export function foldTimeline(timeline: EventTimelineEntry[]): MachineState {
  const s: MachineState = {
    closedByUs: false,
    rejectedAt: null,
    lastOut: null,
    pending: null,
    lastAck: null,
    lastIn: null,
    ooo: null,
    trailingFollowUps: 0,
  };
  const sorted = [...timeline].sort(
    (a, b) => a.at.localeCompare(b.at) || a.mailId - b.mailId,
  );
  for (const e of sorted) {
    if (e.dir === "out") {
      s.pending = null;
      s.lastAck = null;
      s.lastIn = null;
      s.ooo = null;
      s.lastOut = e;
      switch (e.event) {
        case "withdrawn":
          s.closedByUs = true;
          break;
        case "thanks_sent":
          if (s.rejectedAt) s.closedByUs = true;
          break;
        case "follow_up_sent":
          s.trailingFollowUps += 1;
          break;
        default:
          // application_sent / other (reply, question) → process continues
          s.rejectedAt = null;
          s.closedByUs = false;
          s.trailingFollowUps = 0;
      }
      continue;
    }
    s.lastIn = e;
    if (e.event === "rejection") {
      s.rejectedAt = e.at;
      s.closedByUs = false;
      s.pending = null;
      continue;
    }
    if (NEEDS_ACTION_EVENTS.has(e.event) || NEEDS_REPLY_EVENTS.has(e.event)) {
      s.pending = e;
      s.rejectedAt = null;
      s.closedByUs = false;
      s.trailingFollowUps = 0;
      continue;
    }
    if (e.event === "ack" || e.event === "auto_ack") s.lastAck = e;
    if (e.event === "ooo") s.ooo = e;
  }
  return s;
}

/**
 * Time-dependent status resolution. Does not write to DB.
 */
export function effective(input: EffectiveInput): EffectiveResult {
  const nowMs = input.now ?? Date.now();
  const facts = input.facts;
  const rejectionCloseDays = Math.max(
    1,
    input.rejectionCloseDays ?? DEFAULT_REJECTION_CLOSE_DAYS,
  );
  const staleCloseDays = Math.max(
    1,
    input.staleCloseDays ?? DEFAULT_STALE_CLOSE_DAYS,
  );

  if (input.userState === "inactive" || input.userState === "dismissed") {
    return result("inactive");
  }

  if (facts.fromResearchOnly && !facts.hasOutbound) {
    return result("ready_to_send");
  }

  const s = foldTimeline(facts.timeline);

  if (s.closedByUs) {
    return result("closed", {
      sentiment: s.rejectedAt ? "negative" : null,
    });
  }

  if (s.rejectedAt) {
    const closeAt = plusDays(s.rejectedAt, rejectionCloseDays);
    if (nowMs >= closeAt) {
      return result("closed", { sentiment: "negative" });
    }
    return result("rejected", {
      sentiment: "negative",
      waitingOn: "us",
      nextTransitionAt: toIso(closeAt),
    });
  }

  if (s.pending) {
    if (NEEDS_ACTION_EVENTS.has(s.pending.event)) {
      const staleAt = plusDays(s.pending.at, staleCloseDays);
      if (nowMs >= staleAt) return result("closed");
      return result("needs_action", {
        waitingOn: "us",
        nextTransitionAt: toIso(staleAt),
      });
    }
    return result("needs_reply", {
      sentiment:
        s.pending.event === "interview_invite" || s.pending.event === "offer"
          ? "positive"
          : "neutral",
      waitingOn: "us",
    });
  }

  const anchor = s.lastOut?.at ?? s.lastAck?.at ?? s.lastIn?.at ?? null;
  if (!anchor) {
    return result("in_progress", { waitingOn: "them" });
  }

  const staleAt = plusDays(anchor, staleCloseDays);
  if (nowMs >= staleAt) return result("closed");

  const oooUntil = s.ooo?.waitingUntil?.slice(0, 10) || null;
  if (oooUntil) {
    const eod = endOfDayUtc(oooUntil);
    const nextFollowUpAt = nextBusinessDayAfter(oooUntil);
    if (nowMs <= eod) {
      return result("waiting", {
        waitingOn: "them",
        nextFollowUpAt,
        nextTransitionAt: toIso(Math.min(eod + 1000, staleAt)),
        waitingUntil: oooUntil,
      });
    }
    return result("follow_up_due", {
      waitingOn: "them",
      nextFollowUpAt,
      nextTransitionAt: toIso(staleAt),
      waitingUntil: oooUntil,
    });
  }

  const needed = followUpSilenceDays(s.trailingFollowUps, input.followUpDays);
  const followAt = plusDays(anchor, needed);
  if (nowMs >= followAt) {
    return result("follow_up_due", {
      waitingOn: "them",
      nextFollowUpAt: toIso(followAt),
      nextTransitionAt: toIso(staleAt),
    });
  }
  return result("in_progress", {
    waitingOn: "them",
    nextFollowUpAt: toIso(followAt),
    nextTransitionAt: toIso(Math.min(followAt, staleAt)),
  });
}

/**
 * Timeline for rows derived before events_json existed: rebuilt from the
 * cached fact columns so effective() still has an anchor until refresh.
 */
function legacyTimeline(row: {
  lastOutboundAt: string | null;
  lastInboundAt: string | null;
  lastMeaningfulInboundAt: string | null;
  lastIntent: string | null;
  waitingUntil: string | null;
  followUpCount: number;
  flagsJson: string | null;
}): EventTimelineEntry[] {
  const flags = parseFlagsJson(row.flagsJson);
  const out: EventTimelineEntry[] = [];
  if (row.lastMeaningfulInboundAt && flags.rejected) {
    out.push({
      mailId: 0,
      at: row.lastMeaningfulInboundAt,
      dir: "in",
      event: "rejection",
      origin: "intent",
    });
  }
  if (row.lastInboundAt && row.lastInboundAt !== row.lastMeaningfulInboundAt) {
    const event =
      eventFromIntent(
        (row.lastIntent as Parameters<typeof eventFromIntent>[0]) || "unknown",
      ) || "other";
    out.push({
      mailId: 0,
      at: row.lastInboundAt,
      dir: "in",
      event,
      origin: "intent",
      waitingUntil: row.waitingUntil,
    });
  }
  if (row.lastOutboundAt) {
    out.push({
      mailId: 0,
      at: row.lastOutboundAt,
      dir: "out",
      event: flags.thanksSent
        ? "thanks_sent"
        : row.followUpCount > 0
          ? "follow_up_sent"
          : "application_sent",
      origin: "structural",
    });
  }
  return out;
}

/** Build ItemFacts from a tracker_items row (for list computed-on-read). */
export function factsFromItemRow(row: {
  aiStatus: string | null;
  status: string;
  lastOutboundAt: string | null;
  lastInboundAt: string | null;
  lastMeaningfulInboundAt: string | null;
  waitingUntil: string | null;
  lastIntent: string | null;
  flagsJson: string | null;
  eventsJson?: string | null;
  followUpCount: number;
  researchJobId: string | null;
  notesJson: string | null;
}): ItemFacts {
  let notesWaiting: string | null = null;
  let notesSubject: string | null = null;
  let notesBody: string | null = null;
  let notesFrom: string | null = null;
  try {
    if (row.notesJson) {
      const n = JSON.parse(row.notesJson) as Record<string, unknown>;
      if (typeof n.waitingUntil === "string") notesWaiting = n.waitingUntil;
      if (typeof n.lastInboundSubject === "string")
        notesSubject = n.lastInboundSubject;
      if (typeof n.lastInboundBody === "string") notesBody = n.lastInboundBody;
      if (typeof n.lastInboundFrom === "string") notesFrom = n.lastInboundFrom;
    }
  } catch {
    /* ignore */
  }

  const flags = parseFlagsJson(row.flagsJson);
  const hasOutbound = Boolean(row.lastOutboundAt);
  const hasInbound = Boolean(row.lastInboundAt);
  const waitingUntil = row.waitingUntil || notesWaiting;

  return {
    lastOutboundAt: row.lastOutboundAt,
    lastInboundAt: row.lastInboundAt,
    lastMeaningfulInboundAt: row.lastMeaningfulInboundAt,
    waitingUntil,
    lastIntent: (row.lastIntent as ItemFacts["lastIntent"]) || null,
    followUpCount: row.followUpCount,
    hasOutbound,
    hasInbound,
    isThanksSent: flags.thanksSent,
    fromResearchOnly: !hasOutbound && !hasInbound && Boolean(row.researchJobId),
    lastInboundSubject: notesSubject,
    lastInboundBody: notesBody,
    lastInboundFrom: notesFrom,
    flags,
    aiStatus: row.aiStatus,
    timeline:
      parseTimeline(row.eventsJson) ??
      legacyTimeline({ ...row, waitingUntil }),
  };
}
