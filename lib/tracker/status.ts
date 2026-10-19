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
} from "./signals";
import type {
  TrackerSentiment,
  TrackerStatus,
  WaitingOn,
} from "./types";

/** After a follow-up is sent, block the next one for this many days. */
export const FOLLOW_UP_REPEAT_COOLDOWN_DAYS = 7;

/**
 * After a rejection, we are expected to send thanks/feedback.
 * If we stay silent this many days, auto-close the thread.
 */
export const REJECTION_AUTO_CLOSE_DAYS = 7;

export type StatusInput = {
  aiStatus: TrackerStatus | string | null;
  sentiment: TrackerSentiment | string | null;
  waitingOn: WaitingOn | string | null;
  waitingUntil: string | null;
  lastOutboundAt: string | null;
  lastInboundAt: string | null;
  /** Last INBOX that is not auto-reply / pure ACK / click-CTA */
  lastMeaningfulInboundAt: string | null;
  followUpCount: number;
  followUpDays: number;
  hasOutbound: boolean;
  hasInbound: boolean;
  isThanksSent: boolean;
  fromResearchOnly: boolean;
  lastInboundSubject?: string | null;
  lastInboundBody?: string | null;
  lastInboundFrom?: string | null;
  isAutoReply?: boolean;
  isAckOnly?: boolean;
  isClickAction?: boolean;
  /** Last meaningful inbound looks like a rejection */
  isRejected?: boolean;
};

/** First follow-up uses settings days; each later one waits a fixed 7-day cooldown. */
export function followUpSilenceDays(
  followUpCount: number,
  followUpDays: number,
): number {
  if (followUpCount >= 1) return FOLLOW_UP_REPEAT_COOLDOWN_DAYS;
  return Math.max(1, followUpDays);
}

function daysBetween(iso: string, now = Date.now()): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return (now - t) / (1000 * 60 * 60 * 24);
}

/** Rejection + no outbound from us for REJECTION_AUTO_CLOSE_DAYS → closed. */
function shouldAutoCloseRejected(input: StatusInput): boolean {
  const anchor = input.lastMeaningfulInboundAt || input.lastInboundAt;
  if (!anchor) return false;
  if (
    input.lastOutboundAt &&
    Date.parse(input.lastOutboundAt) > Date.parse(anchor)
  ) {
    return false;
  }
  return daysBetween(anchor) >= REJECTION_AUTO_CLOSE_DAYS;
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

/**
 * Deterministic overrides on top of AI classification.
 */
export function resolveStatus(input: StatusInput): {
  status: TrackerStatus;
  sentiment: TrackerSentiment | null;
  waitingOn: WaitingOn | null;
  nextFollowUpAt: string | null;
  ignored: boolean;
  waitingUntil: string | null;
} {
  const sentiment =
    input.sentiment === "positive" ||
    input.sentiment === "negative" ||
    input.sentiment === "neutral"
      ? input.sentiment
      : null;
  let waitingOn: WaitingOn | null =
    input.waitingOn === "us" || input.waitingOn === "them"
      ? input.waitingOn
      : null;

  if (input.fromResearchOnly && !input.hasOutbound) {
    return {
      status: "ready_to_send",
      sentiment: null,
      waitingOn: null,
      nextFollowUpAt: null,
      ignored: false,
      waitingUntil: null,
    };
  }

  if (input.isThanksSent || asStatus(input.aiStatus) === "closed") {
    return {
      status: "closed",
      sentiment,
      waitingOn: null,
      nextFollowUpAt: null,
      ignored: false,
      waitingUntil: null,
    };
  }

  const lastSub = input.lastInboundSubject || "";
  const lastBody = normalizeMailText(input.lastInboundBody || "");
  const lastFrom = input.lastInboundFrom || "";
  const lastIsOoo = Boolean(lastSub) && detectOooAway(lastSub, lastBody);
  const lastIsReject =
    input.isRejected ||
    (Boolean(lastSub) && detectRejection(lastSub, lastBody));
  const lastIsAutoAck =
    Boolean(lastSub) && detectAutoAck(lastSub, lastBody);
  const lastIsOptionalPortal =
    Boolean(lastSub) && detectOptionalPortalLink(lastSub, lastBody);
  const lastIsClick =
    !lastIsOptionalPortal &&
    !lastIsReject &&
    (input.isClickAction ||
      (lastSub &&
        !lastIsOoo &&
        detectClickAction(lastSub, lastBody, lastFrom)));
  const lastIsAck =
    input.isAckOnly ||
    lastIsAutoAck ||
    lastIsOptionalPortal ||
    (lastSub &&
      !lastIsOoo &&
      !lastIsClick &&
      !lastIsReject &&
      detectAckOnly(lastSub, lastBody, lastFrom));

  let waitingUntil = lastIsOoo
    ? input.waitingUntil?.slice(0, 10) ||
      parseReturnDate(`${lastSub}\n${lastBody}`)
    : null;

  const outboundAfterLastInbound =
    Boolean(input.lastOutboundAt) &&
    Boolean(input.lastInboundAt) &&
    Date.parse(input.lastOutboundAt!) > Date.parse(input.lastInboundAt!);

  // Soft/hard rejection when it is still the latest word (no later outbound)
  const rejectionStands =
    lastIsReject ||
    (Boolean(input.isRejected) &&
      Boolean(input.lastMeaningfulInboundAt) &&
      (!input.lastOutboundAt ||
        Date.parse(input.lastOutboundAt) <=
          Date.parse(input.lastMeaningfulInboundAt!))) ||
    asStatus(input.aiStatus) === "rejected";

  if (rejectionStands && (lastIsReject || input.isRejected)) {
    if (shouldAutoCloseRejected(input)) {
      return {
        status: "closed",
        sentiment: sentiment || "negative",
        waitingOn: null,
        nextFollowUpAt: null,
        ignored: false,
        waitingUntil: null,
      };
    }
    return {
      status: "rejected",
      sentiment: sentiment || "negative",
      waitingOn: "us",
      nextFollowUpAt: null,
      ignored: false,
      waitingUntil: null,
    };
  }

  // OOO / dated wait
  if (lastIsOoo && !outboundAfterLastInbound) {
    if (waitingUntil) {
      if (Date.now() <= endOfDayUtc(waitingUntil)) {
        return {
          status: "waiting",
          sentiment,
          waitingOn: "them",
          nextFollowUpAt: nextBusinessDayAfter(waitingUntil),
          ignored: false,
          waitingUntil,
        };
      }
      return {
        status: "follow_up_due",
        sentiment,
        waitingOn: "them",
        nextFollowUpAt: nextBusinessDayAfter(waitingUntil),
        ignored: false,
        waitingUntil,
      };
    }
    return {
      status: "waiting",
      sentiment,
      waitingOn: "them",
      nextFollowUpAt: null,
      ignored: false,
      waitingUntil: null,
    };
  }

  let status = asStatus(input.aiStatus) || "in_progress";

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
      ignored: false,
      waitingUntil: null,
    };
  }

  const meaningfulIn = input.lastMeaningfulInboundAt || null;

  /**
   * Silence clock while ball is with THEM:
   * - After our outbound (application / follow-up), if no later *meaningful* human reply
   * - After ATS/thank-you ACK only (website apply) — clock from ACK
   * - After their "please apply" + our portal apply → only ACK (no SENT) — clock from ACK
   * ACK / auto-receipt after our mail must NOT reset the clock.
   */
  const silenceAnchor = ((): string | null => {
    const out = input.lastOutboundAt;
    const ackAt = lastIsAck ? input.lastInboundAt : null;

    // Our last real action is still newer than any human reply from them
    if (out && (!meaningfulIn || Date.parse(out) >= Date.parse(meaningfulIn))) {
      return out;
    }

    // Thank-you / auto-ACK is the latest inbound noise — clock from ACK
    // (website apply with no SENT, OR portal apply after their invite while
    // last SENT is older than their invite)
    if (
      ackAt &&
      (!meaningfulIn || Date.parse(ackAt) >= Date.parse(meaningfulIn))
    ) {
      return ackAt;
    }

    return null;
  })();

  // ACK / silence never stays as needs_* — ball is with them
  if (
    silenceAnchor &&
    (status === "needs_reply" || status === "needs_action") &&
    (lastIsAck || !meaningfulIn || (input.lastOutboundAt &&
      Date.parse(input.lastOutboundAt) >= Date.parse(meaningfulIn)))
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
    const elapsed = daysBetween(silenceAnchor);
    const needed = followUpSilenceDays(
      input.followUpCount,
      input.followUpDays,
    );
    const next = new Date(Date.parse(silenceAnchor));
    next.setDate(next.getDate() + needed);
    const nextIso = next.toISOString();

    // After 2 follow-ups + another full silence window → ignored
    if (input.followUpCount >= 2 && elapsed >= needed) {
      return {
        status: "ignored",
        sentiment,
        waitingOn: null,
        nextFollowUpAt: null,
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
        ignored: false,
        waitingUntil: null,
      };
    }
    // Still inside silence / post-follow-up cooldown — do not stay follow_up_due
    return {
      status: "in_progress",
      sentiment,
      waitingOn: "them",
      nextFollowUpAt: nextIso,
      ignored: false,
      waitingUntil: null,
    };
  }

  if (status === "rejected") {
    if (shouldAutoCloseRejected(input)) {
      return {
        status: "closed",
        sentiment: sentiment || "negative",
        waitingOn: null,
        nextFollowUpAt: null,
        ignored: false,
        waitingUntil: null,
      };
    }
    return {
      status: "rejected",
      sentiment: sentiment || "negative",
      waitingOn: "us",
      nextFollowUpAt: null,
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
      ignored: true,
      waitingUntil: null,
    };
  }

  if (status === "ready_to_send" && input.hasOutbound) {
    status = "in_progress";
  }

  // AI said follow_up_due but silence clock not yet elapsed → in_progress
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
    ignored: false,
    waitingUntil: null,
  };
}
