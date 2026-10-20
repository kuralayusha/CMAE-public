/**
 * Status resolution — Faz 4 split:
 * - facts: time-independent signals (see derive/facts.ts)
 * - effective: computed-on-read with clock (see derive/effective.ts)
 *
 * `resolveStatus` remains for legacy call sites; it delegates to effective().
 */

import { effective, type EffectiveResult } from "./derive/effective";
import type { ItemFacts } from "./derive/facts";
import {
  FOLLOW_UP_REPEAT_COOLDOWN_DAYS,
  REJECTION_AUTO_CLOSE_DAYS,
  followUpSilenceDays,
} from "./status-constants";
import type {
  TrackerSentiment,
  TrackerStatus,
  WaitingOn,
} from "./types";

export {
  FOLLOW_UP_REPEAT_COOLDOWN_DAYS,
  REJECTION_AUTO_CLOSE_DAYS,
  followUpSilenceDays,
};

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
  /** Optional clock for tests / computed-on-read */
  now?: number;
  userState?: string;
};

function toFacts(input: StatusInput): ItemFacts {
  return {
    lastOutboundAt: input.lastOutboundAt,
    lastInboundAt: input.lastInboundAt,
    lastMeaningfulInboundAt: input.lastMeaningfulInboundAt,
    waitingUntil: input.waitingUntil,
    lastIntent: null,
    followUpCount: input.followUpCount,
    hasOutbound: input.hasOutbound,
    hasInbound: input.hasInbound,
    isThanksSent: input.isThanksSent,
    fromResearchOnly: input.fromResearchOnly,
    lastInboundSubject: input.lastInboundSubject ?? null,
    lastInboundBody: input.lastInboundBody ?? null,
    lastInboundFrom: input.lastInboundFrom ?? null,
    flags: {
      autoReply: Boolean(input.isAutoReply),
      ackOnly: Boolean(input.isAckOnly),
      clickAction: Boolean(input.isClickAction),
      rejected: Boolean(input.isRejected),
      thanksSent: input.isThanksSent,
      bounced: false,
    },
    aiStatus: input.aiStatus,
  };
}

/**
 * Deterministic overrides on top of AI classification.
 * Prefer `effective()` + `computeFacts()` for new code.
 */
export function resolveStatus(input: StatusInput): {
  status: TrackerStatus;
  sentiment: TrackerSentiment | null;
  waitingOn: WaitingOn | null;
  nextFollowUpAt: string | null;
  ignored: boolean;
  waitingUntil: string | null;
  nextTransitionAt?: string | null;
} {
  const result: EffectiveResult = effective({
    facts: toFacts(input),
    userState: input.userState || "active",
    followUpDays: input.followUpDays,
    now: input.now,
  });

  // Preserve legacy sentiment passthrough when effective leaves it null
  const sentiment =
    input.sentiment === "positive" ||
    input.sentiment === "negative" ||
    input.sentiment === "neutral"
      ? input.sentiment
      : result.sentiment;

  return {
    status: result.status,
    sentiment: result.sentiment ?? sentiment,
    waitingOn: result.waitingOn,
    nextFollowUpAt: result.nextFollowUpAt,
    ignored: result.ignored,
    waitingUntil: result.waitingUntil,
    nextTransitionAt: result.nextTransitionAt,
  };
}
