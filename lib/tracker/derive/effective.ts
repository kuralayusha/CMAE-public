/**
 * Computed-on-read status from stored facts + user overlay + clock.
 * Pure: pass `now` for fake-clock tests / follow-up transitions without sync.
 */

import {
  detectAckOnly,
  detectAutoAck,
  detectClickAction,
  detectOooAway,
  detectOptionalPortalLink,
  detectRejection,
  endOfDayUtc,
  nextBusinessDayAfter,
  normalizeMailText,
  parseReturnDate,
} from "../signals";
import {
  FOLLOW_UP_REPEAT_COOLDOWN_DAYS,
  REJECTION_AUTO_CLOSE_DAYS,
  followUpSilenceDays,
} from "../status-constants";
import type {
  TrackerSentiment,
  TrackerStatus,
  WaitingOn,
} from "../types";
import type { ItemFacts } from "./facts";
import { parseFlagsJson } from "./facts";

export type EffectiveInput = {
  facts: ItemFacts;
  userState: "active" | "inactive" | "dismissed" | string;
  followUpDays: number;
  now?: number;
};

export type EffectiveResult = {
  status: TrackerStatus;
  sentiment: TrackerSentiment | null;
  waitingOn: WaitingOn | null;
  nextFollowUpAt: string | null;
  nextTransitionAt: string | null;
  ignored: boolean;
  waitingUntil: string | null;
};

function daysBetween(iso: string, nowMs: number): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return (nowMs - t) / (1000 * 60 * 60 * 24);
}

function asStatus(v: string | null | undefined): TrackerStatus | null {
  const allowed: TrackerStatus[] = [
    "ready_to_send",
    "needs_reply",
    "needs_action",
    "follow_up_due",
    "waiting",
    "in_progress",
    "rejected",
    "closed",
    "inactive",
    "ignored",
  ];
  if (!v) return null;
  return allowed.includes(v as TrackerStatus) ? (v as TrackerStatus) : null;
}

function shouldAutoCloseRejected(
  facts: ItemFacts,
  nowMs: number,
): boolean {
  const anchor = facts.lastMeaningfulInboundAt || facts.lastInboundAt;
  if (!anchor) return false;
  if (
    facts.lastOutboundAt &&
    Date.parse(facts.lastOutboundAt) > Date.parse(anchor)
  ) {
    return false;
  }
  return daysBetween(anchor, nowMs) >= REJECTION_AUTO_CLOSE_DAYS;
}

function sooner(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

/**
 * Time-dependent status resolution. Does not write to DB.
 */
export function effective(input: EffectiveInput): EffectiveResult {
  const nowMs = input.now ?? Date.now();
  const facts = input.facts;

  if (input.userState === "inactive" || input.userState === "dismissed") {
    return {
      status: "inactive",
      sentiment: null,
      waitingOn: null,
      nextFollowUpAt: null,
      nextTransitionAt: null,
      ignored: false,
      waitingUntil: null,
    };
  }

  const sentiment: TrackerSentiment | null = null;
  let waitingOn: WaitingOn | null = null;

  if (facts.fromResearchOnly && !facts.hasOutbound) {
    return {
      status: "ready_to_send",
      sentiment: null,
      waitingOn: null,
      nextFollowUpAt: null,
      nextTransitionAt: null,
      ignored: false,
      waitingUntil: null,
    };
  }

  if (facts.isThanksSent || asStatus(facts.aiStatus) === "closed") {
    return {
      status: "closed",
      sentiment,
      waitingOn: null,
      nextFollowUpAt: null,
      nextTransitionAt: null,
      ignored: false,
      waitingUntil: null,
    };
  }

  const lastSub = facts.lastInboundSubject || "";
  const lastBody = normalizeMailText(facts.lastInboundBody || "");
  const lastFrom = facts.lastInboundFrom || "";
  const lastIsOoo =
    Boolean(lastSub) && detectOooAway(lastSub, lastBody);
  const lastIsReject =
    facts.flags.rejected ||
    (Boolean(lastSub) && detectRejection(lastSub, lastBody));
  const lastIsAutoAck =
    Boolean(lastSub) && detectAutoAck(lastSub, lastBody);
  const lastIsOptionalPortal =
    Boolean(lastSub) && detectOptionalPortalLink(lastSub, lastBody);
  const lastIsClick =
    !lastIsOptionalPortal &&
    !lastIsReject &&
    (facts.flags.clickAction ||
      (lastSub &&
        !lastIsOoo &&
        detectClickAction(lastSub, lastBody, lastFrom)));
  const lastIsAck =
    facts.flags.ackOnly ||
    lastIsAutoAck ||
    lastIsOptionalPortal ||
    (lastSub &&
      !lastIsOoo &&
      !lastIsClick &&
      !lastIsReject &&
      detectAckOnly(lastSub, lastBody, lastFrom));

  let waitingUntil = lastIsOoo
    ? facts.waitingUntil?.slice(0, 10) ||
      parseReturnDate(`${lastSub}\n${lastBody}`)
    : null;

  const outboundAfterLastInbound =
    Boolean(facts.lastOutboundAt) &&
    Boolean(facts.lastInboundAt) &&
    Date.parse(facts.lastOutboundAt!) > Date.parse(facts.lastInboundAt!);

  const rejectionStands =
    lastIsReject ||
    (Boolean(facts.flags.rejected) &&
      Boolean(facts.lastMeaningfulInboundAt) &&
      (!facts.lastOutboundAt ||
        Date.parse(facts.lastOutboundAt) <=
          Date.parse(facts.lastMeaningfulInboundAt!))) ||
    asStatus(facts.aiStatus) === "rejected";

  if (rejectionStands && (lastIsReject || facts.flags.rejected)) {
    if (shouldAutoCloseRejected(facts, nowMs)) {
      return {
        status: "closed",
        sentiment: sentiment || "negative",
        waitingOn: null,
        nextFollowUpAt: null,
        nextTransitionAt: null,
        ignored: false,
        waitingUntil: null,
      };
    }
    const anchor = facts.lastMeaningfulInboundAt || facts.lastInboundAt;
    const closeAt = anchor
      ? new Date(
          Date.parse(anchor) +
            REJECTION_AUTO_CLOSE_DAYS * 24 * 60 * 60 * 1000,
        ).toISOString()
      : null;
    return {
      status: "rejected",
      sentiment: sentiment || "negative",
      waitingOn: "us",
      nextFollowUpAt: null,
      nextTransitionAt: closeAt,
      ignored: false,
      waitingUntil: null,
    };
  }

  if (lastIsOoo && !outboundAfterLastInbound) {
    if (waitingUntil) {
      const eod = endOfDayUtc(waitingUntil);
      if (nowMs <= eod) {
        return {
          status: "waiting",
          sentiment,
          waitingOn: "them",
          nextFollowUpAt: nextBusinessDayAfter(waitingUntil),
          nextTransitionAt: new Date(eod).toISOString(),
          ignored: false,
          waitingUntil,
        };
      }
      return {
        status: "follow_up_due",
        sentiment,
        waitingOn: "them",
        nextFollowUpAt: nextBusinessDayAfter(waitingUntil),
        nextTransitionAt: null,
        ignored: false,
        waitingUntil,
      };
    }
    return {
      status: "waiting",
      sentiment,
      waitingOn: "them",
      nextFollowUpAt: null,
      nextTransitionAt: null,
      ignored: false,
      waitingUntil: null,
    };
  }

  let status = asStatus(facts.aiStatus) || "in_progress";

  if (status === "waiting" && !lastIsOoo) {
    status = "in_progress";
  }

  if (lastIsAck && (status === "needs_reply" || status === "needs_action")) {
    status = "in_progress";
    waitingOn = "them";
  }

  if (
    (lastIsClick || (status === "needs_action" && !lastIsAck)) &&
    !outboundAfterLastInbound &&
    !lastIsAck
  ) {
    return {
      status: "needs_action",
      sentiment: null,
      waitingOn: "us",
      nextFollowUpAt: null,
      nextTransitionAt: null,
      ignored: false,
      waitingUntil: null,
    };
  }

  const meaningfulIn = facts.lastMeaningfulInboundAt || null;

  const silenceAnchor = ((): string | null => {
    const out = facts.lastOutboundAt;
    const ackAt = lastIsAck ? facts.lastInboundAt : null;

    if (out && (!meaningfulIn || Date.parse(out) >= Date.parse(meaningfulIn))) {
      return out;
    }
    if (
      ackAt &&
      (!meaningfulIn || Date.parse(ackAt) >= Date.parse(meaningfulIn))
    ) {
      return ackAt;
    }
    return null;
  })();

  if (
    silenceAnchor &&
    (status === "needs_reply" || status === "needs_action") &&
    (lastIsAck ||
      !meaningfulIn ||
      (facts.lastOutboundAt &&
        Date.parse(facts.lastOutboundAt) >= Date.parse(meaningfulIn)))
  ) {
    status = "in_progress";
    waitingOn = "them";
  }

  if (
    silenceAnchor &&
    status !== "rejected" &&
    status !== "closed" &&
    status !== "needs_reply" &&
    status !== "needs_action"
  ) {
    const elapsed = daysBetween(silenceAnchor, nowMs);
    const needed = followUpSilenceDays(
      facts.followUpCount,
      input.followUpDays,
    );
    const next = new Date(Date.parse(silenceAnchor));
    next.setDate(next.getDate() + needed);
    const nextIso = next.toISOString();

    if (facts.followUpCount >= 2 && elapsed >= needed) {
      return {
        status: "ignored",
        sentiment,
        waitingOn: null,
        nextFollowUpAt: null,
        nextTransitionAt: null,
        ignored: true,
        waitingUntil: null,
      };
    }
    if (elapsed >= needed) {
      return {
        status: "follow_up_due",
        sentiment,
        waitingOn: "them",
        nextFollowUpAt: nextIso,
        nextTransitionAt: null,
        ignored: false,
        waitingUntil: null,
      };
    }
    return {
      status: "in_progress",
      sentiment,
      waitingOn: "them",
      nextFollowUpAt: nextIso,
      nextTransitionAt: nextIso,
      ignored: false,
      waitingUntil: null,
    };
  }

  if (status === "rejected") {
    if (shouldAutoCloseRejected(facts, nowMs)) {
      return {
        status: "closed",
        sentiment: sentiment || "negative",
        waitingOn: null,
        nextFollowUpAt: null,
        nextTransitionAt: null,
        ignored: false,
        waitingUntil: null,
      };
    }
    return {
      status: "rejected",
      sentiment: sentiment || "negative",
      waitingOn: "us",
      nextFollowUpAt: null,
      nextTransitionAt: null,
      ignored: false,
      waitingUntil: null,
    };
  }

  if (status === "needs_reply") {
    return {
      status: "needs_reply",
      sentiment: sentiment || "neutral",
      waitingOn: "us",
      nextFollowUpAt: null,
      nextTransitionAt: null,
      ignored: false,
      waitingUntil: null,
    };
  }

  if (status === "waiting") {
    return {
      status: "waiting",
      sentiment,
      waitingOn: "them",
      nextFollowUpAt: waitingUntil ? nextBusinessDayAfter(waitingUntil) : null,
      nextTransitionAt: waitingUntil
        ? new Date(endOfDayUtc(waitingUntil)).toISOString()
        : null,
      ignored: false,
      waitingUntil,
    };
  }

  if (status === "ignored") {
    return {
      status: "ignored",
      sentiment,
      waitingOn: null,
      nextFollowUpAt: null,
      nextTransitionAt: null,
      ignored: true,
      waitingUntil: null,
    };
  }

  if (status === "ready_to_send" && facts.hasOutbound) {
    status = "in_progress";
  }

  if (status === "follow_up_due" && !silenceAnchor) {
    status = "in_progress";
  }

  const fallbackWaitingOn: WaitingOn | null =
    status === "in_progress" || status === "follow_up_due" ? "them" : null;

  return {
    status: status === "follow_up_due" ? "follow_up_due" : status,
    sentiment,
    waitingOn: waitingOn ?? fallbackWaitingOn,
    nextFollowUpAt: null,
    nextTransitionAt: sooner(null, waitingUntil
      ? new Date(endOfDayUtc(waitingUntil)).toISOString()
      : null),
    ignored: false,
    waitingUntil: null,
  };
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

  return {
    lastOutboundAt: row.lastOutboundAt,
    lastInboundAt: row.lastInboundAt,
    lastMeaningfulInboundAt: row.lastMeaningfulInboundAt,
    waitingUntil: row.waitingUntil || notesWaiting,
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
    aiStatus: row.aiStatus || (row.status !== "inactive" ? row.status : null),
  };
}
