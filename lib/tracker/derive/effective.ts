/**
 * Stage 4 — computed-on-read status from the per-mail event timeline + user
 * overlay + clock + settings (architecture §2.6.9). Pure: pass `now` for
 * fake-clock tests / transitions without sync.
 *
 * Rules:
 * - rejection latches: our outbound other/follow_up never clears it; only a
 *   real process restart (application_sent, AI invite/offer/assessment, or
 *   AI info_request/action_required) does. thanks_sent while latched → closed.
 * - Close after rejection: max(rejectedAt, aftermathAt) + rejectionCloseDays.
 * - withdrawn → closed. Offer + our reply (not withdrawn) → waiting until stale.
 * - interview_invite / info_request / offer after the last outbound → needs_reply;
 *   action_required / assessment → needs_action (closes when stale).
 * - ooo / scheduledAt with a future day → waiting until end of that day.
 * - otherwise silence: follow_up_due after followUpDays (7-day cooldown once a
 *   follow-up was sent) from the last outbound (or the last ack / inbound when
 *   nothing was sent by mail); `staleCloseDays` after that anchor → closed.
 * - Position groups (optional `pos` on events): fold each cluster, take the
 *   most active status so one employer's rejected role does not bury another.
 */

import { endOfDayUtc, nextBusinessDayAfter } from "../signals";
import {
  DEFAULT_REJECTION_CLOSE_DAYS,
  DEFAULT_STALE_CLOSE_DAYS,
  followUpSilenceDays,
} from "../status-constants";
import type { TrackerSentiment, TrackerStatus, WaitingOn } from "../types";
import { nameSimilarity } from "./identity";
import {
  compareTimelineEntries,
  eventFromIntent,
  NEEDS_ACTION_EVENTS,
  NEEDS_REPLY_EVENTS,
  parseTimeline,
  type EventTimelineEntry,
} from "./events";
import type { ItemFacts } from "./facts";
import { parseFlagsJson } from "./flags";

export { compareTimelineEntries } from "./events";

export type EffectiveInput = {
  facts: ItemFacts;
  userState: "active" | "inactive" | "dismissed" | string;
  followUpDays: number;
  rejectionCloseDays?: number;
  staleCloseDays?: number;
  now?: number;
};

export type WaitingReason = "interview" | "ooo" | "offer";

export type EffectiveResult = {
  status: TrackerStatus;
  sentiment: TrackerSentiment | null;
  waitingOn: WaitingOn | null;
  nextFollowUpAt: string | null;
  /** When the computed status changes next without new mail (clock only). */
  nextTransitionAt: string | null;
  ignored: boolean;
  waitingUntil: string | null;
  /** Closed row received a later human inbound — UI badge only. */
  mailAfterClose?: boolean;
  /** Why status is waiting — drives Interview vs OOO labels. */
  waitingReason?: WaitingReason | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Status priority when merging position groups (higher = more active). */
const STATUS_PRIORITY: Record<TrackerStatus, number> = {
  needs_action: 90,
  needs_reply: 80,
  waiting: 70,
  follow_up_due: 60,
  in_progress: 50,
  ready_to_send: 40,
  rejected: 30,
  closed: 20,
  inactive: 10,
  ignored: 0,
};

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

export type MachineState = {
  closedByUs: boolean;
  rejectedAt: string | null;
  /** Last activity while the rejection latch is set (extends close clock). */
  aftermathAt: string | null;
  lastOut: EventTimelineEntry | null;
  pending: EventTimelineEntry | null;
  lastAck: EventTimelineEntry | null;
  lastIn: EventTimelineEntry | null;
  ooo: EventTimelineEntry | null;
  trailingFollowUps: number;
  /** We replied to an offer (accept / negotiate); not withdrawn. */
  offerRepliedAt: string | null;
  mailAfterClose: boolean;
  /** Latest interview / meeting / assessment day from scheduledAt. */
  scheduledUntil: string | null;
  /** scheduledUntil came from an interview_invite (UI: Interview). */
  scheduledFromInterview: boolean;
};

function isAiStored(e: EventTimelineEntry): boolean {
  return e.origin === "stored" && e.source === "ai";
}

/** Inbound events that reopen a latched rejection. */
function opensRejectionLatch(e: EventTimelineEntry): boolean {
  if (e.event === "interview_invite" || e.event === "offer" || e.event === "assessment") {
    return true;
  }
  if (e.event === "info_request" || e.event === "action_required") {
    return isAiStored(e);
  }
  return false;
}

function clearLatch(s: MachineState): void {
  s.rejectedAt = null;
  s.aftermathAt = null;
  s.closedByUs = false;
  s.trailingFollowUps = 0;
}

function bumpAftermath(s: MachineState, at: string): void {
  if (!s.rejectedAt) return;
  if (!s.aftermathAt || at > s.aftermathAt) s.aftermathAt = at;
}

/** Pure fold over the chronological timeline (single position group). */
export function foldTimeline(timeline: EventTimelineEntry[]): MachineState {
  const s: MachineState = {
    closedByUs: false,
    rejectedAt: null,
    aftermathAt: null,
    lastOut: null,
    pending: null,
    lastAck: null,
    lastIn: null,
    ooo: null,
    trailingFollowUps: 0,
    offerRepliedAt: null,
    mailAfterClose: false,
    scheduledUntil: null,
    scheduledFromInterview: false,
  };
  const sorted = [...timeline].sort(compareTimelineEntries);
  for (const e of sorted) {
    const day = e.scheduledAt?.slice(0, 10) || null;
    if (day && (!s.scheduledUntil || day > s.scheduledUntil)) {
      s.scheduledUntil = day;
      s.scheduledFromInterview =
        e.event === "interview_invite" ||
        e.event === "other" ||
        e.event === "ack";
    }

    if (e.dir === "out") {
      if (s.closedByUs) {
        // Outbound after we closed: keep closed; still track for mailAfterClose inbound only.
        s.lastOut = e;
        continue;
      }
      const hadOfferPending = s.pending?.event === "offer";
      s.pending = null;
      s.lastAck = null;
      s.lastIn = null;
      s.ooo = null;
      s.lastOut = e;
      switch (e.event) {
        case "withdrawn":
          s.closedByUs = true;
          s.offerRepliedAt = null;
          break;
        case "thanks_sent":
          if (s.rejectedAt) {
            s.closedByUs = true;
            bumpAftermath(s, e.at);
          } else if (hadOfferPending) {
            s.offerRepliedAt = e.at;
          } else {
            // Courtesy thanks with no open rejection: do not invent follow-ups.
            s.trailingFollowUps = 0;
          }
          break;
        case "follow_up_sent":
          if (s.rejectedAt) {
            bumpAftermath(s, e.at);
          } else {
            s.trailingFollowUps += 1;
            if (hadOfferPending) s.offerRepliedAt = e.at;
          }
          break;
        case "application_sent":
          clearLatch(s);
          s.offerRepliedAt = null;
          break;
        default:
          // other — answer / ask / schedule
          if (s.rejectedAt) {
            bumpAftermath(s, e.at);
          } else {
            s.trailingFollowUps = 0;
            if (hadOfferPending) s.offerRepliedAt = e.at;
          }
      }
      continue;
    }

    // Inbound
    if (s.closedByUs) {
      if (
        e.event !== "ack" &&
        e.event !== "auto_ack" &&
        e.event !== "ooo"
      ) {
        s.mailAfterClose = true;
      }
      continue;
    }

    s.lastIn = e;
    if (e.event === "rejection") {
      s.rejectedAt = e.at;
      s.aftermathAt = e.at;
      s.closedByUs = false;
      s.pending = null;
      s.offerRepliedAt = null;
      continue;
    }
    if (opensRejectionLatch(e)) {
      clearLatch(s);
      if (NEEDS_ACTION_EVENTS.has(e.event) || NEEDS_REPLY_EVENTS.has(e.event)) {
        s.pending = e;
      }
      continue;
    }
    if (NEEDS_ACTION_EVENTS.has(e.event) || NEEDS_REPLY_EVENTS.has(e.event)) {
      // Fallback info_request / action_required while latched: do not reopen.
      if (s.rejectedAt) {
        bumpAftermath(s, e.at);
        continue;
      }
      s.pending = e;
      s.trailingFollowUps = 0;
      continue;
    }
    if (s.rejectedAt) {
      bumpAftermath(s, e.at);
    }
    if (e.event === "ack" || e.event === "auto_ack") s.lastAck = e;
    if (e.event === "ooo") s.ooo = e;
  }
  return s;
}

function resolveFromState(
  s: MachineState,
  input: {
    followUpDays: number;
    rejectionCloseDays: number;
    staleCloseDays: number;
    nowMs: number;
  },
): EffectiveResult {
  const { nowMs, rejectionCloseDays, staleCloseDays, followUpDays } = input;

  if (s.closedByUs) {
    return result("closed", {
      sentiment: s.rejectedAt ? "negative" : null,
      mailAfterClose: s.mailAfterClose || undefined,
    });
  }

  if (s.rejectedAt) {
    const anchor = s.aftermathAt && s.aftermathAt > s.rejectedAt
      ? s.aftermathAt
      : s.rejectedAt;
    const closeAt = plusDays(anchor, rejectionCloseDays);
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

  if (s.offerRepliedAt) {
    const staleAt = plusDays(s.offerRepliedAt, staleCloseDays);
    if (nowMs >= staleAt) return result("closed", { sentiment: "positive" });
    return result("waiting", {
      waitingOn: "them",
      sentiment: "positive",
      nextTransitionAt: toIso(staleAt),
      waitingReason: "offer",
    });
  }

  if (s.scheduledUntil) {
    const eod = endOfDayUtc(s.scheduledUntil);
    const interviewReason: WaitingReason | null = s.scheduledFromInterview
      ? "interview"
      : null;
    if (nowMs <= eod) {
      return result("waiting", {
        waitingOn: "them",
        nextFollowUpAt: nextBusinessDayAfter(s.scheduledUntil),
        nextTransitionAt: toIso(eod + 1000),
        waitingUntil: s.scheduledUntil,
        waitingReason: interviewReason,
      });
    }
    // After the scheduled day: silence clock starts from the interview day,
    // not the last confirmation outbound (avoids instant follow_up_due).
    const needed = followUpSilenceDays(s.trailingFollowUps, followUpDays);
    const followAt = plusDays(s.scheduledUntil, needed);
    const staleAt = plusDays(s.scheduledUntil, staleCloseDays);
    if (nowMs >= staleAt) return result("closed");
    if (nowMs >= followAt) {
      return result("follow_up_due", {
        waitingOn: "them",
        nextFollowUpAt: toIso(followAt),
        nextTransitionAt: toIso(staleAt),
        waitingUntil: s.scheduledUntil,
      });
    }
    return result("in_progress", {
      waitingOn: "them",
      nextFollowUpAt: toIso(followAt),
      nextTransitionAt: toIso(Math.min(followAt, staleAt)),
      waitingUntil: s.scheduledUntil,
    });
  }

  const rawAnchor = s.lastOut?.at ?? s.lastAck?.at ?? s.lastIn?.at ?? null;
  if (!rawAnchor) {
    return result("in_progress", { waitingOn: "them" });
  }
  // Future-dated mail must not push silence forever.
  const anchorMs = Math.min(Date.parse(rawAnchor), nowMs);
  const anchor = toIso(anchorMs);

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
        waitingReason: "ooo",
      });
    }
    return result("follow_up_due", {
      waitingOn: "them",
      nextFollowUpAt,
      nextTransitionAt: toIso(staleAt),
      waitingUntil: oooUntil,
    });
  }

  const needed = followUpSilenceDays(s.trailingFollowUps, followUpDays);
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
 * Cluster non-null position labels with nameSimilarity ≥ 0.5.
 * Returns canonical key → members.
 */
export function clusterPositions(labels: string[]): Map<string, string[]> {
  const unique = [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
  const clusters: string[][] = [];
  for (const label of unique) {
    const hit = clusters.find((c) =>
      c.some((m) => nameSimilarity(m, label) >= 0.5),
    );
    if (hit) hit.push(label);
    else clusters.push([label]);
  }
  const out = new Map<string, string[]>();
  for (const c of clusters) {
    const key = [...c].sort()[0]!;
    out.set(key, c);
  }
  return out;
}

function timelinesByPosition(
  timeline: EventTimelineEntry[],
): EventTimelineEntry[][] {
  const labeled = timeline.filter((e) => e.pos?.trim());
  if (!labeled.length) return [timeline];

  const clusters = clusterPositions(labeled.map((e) => e.pos!));
  const groups: EventTimelineEntry[][] = [];
  for (const members of clusters.values()) {
    const set = new Set(members.map((m) => m.toLowerCase()));
    groups.push(
      timeline.filter((e) => {
        if (!e.pos?.trim()) return true; // null pos → every group
        return set.has(e.pos.trim().toLowerCase()) ||
          members.some((m) => nameSimilarity(m, e.pos!) >= 0.5);
      }),
    );
  }
  return groups.length ? groups : [timeline];
}

function mergeResults(parts: EffectiveResult[]): EffectiveResult {
  if (parts.length === 1) return parts[0]!;
  let best = parts[0]!;
  for (const p of parts.slice(1)) {
    if ((STATUS_PRIORITY[p.status] ?? 0) > (STATUS_PRIORITY[best.status] ?? 0)) {
      best = p;
    }
  }
  return {
    ...best,
    mailAfterClose: parts.some((p) => p.mailAfterClose) || undefined,
  };
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

  const opts = {
    followUpDays: input.followUpDays,
    rejectionCloseDays,
    staleCloseDays,
    nowMs,
  };

  const groups = timelinesByPosition(facts.timeline);
  const parts = groups.map((g) => resolveFromState(foldTimeline(g), opts));
  return mergeResults(parts);
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
