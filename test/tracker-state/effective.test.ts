/**
 * Stage-4 status machine unit tests:
 *   npm run test:tracker-state
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clusterPositions,
  effective,
  foldTimeline,
  type EffectiveResult,
} from "../../lib/tracker/derive/effective";
import {
  compareTimelineEntries,
  LOW_CONFIDENCE,
  timelineUnverified,
  type EventTimelineEntry,
  type MailEvent,
} from "../../lib/tracker/derive/events";
import type { ItemFacts } from "../../lib/tracker/derive/facts";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const SETTINGS = {
  followUpDays: 5,
  rejectionCloseDays: 10,
  staleCloseDays: 20,
};

function e(
  mailId: number,
  at: string,
  dir: "in" | "out",
  event: MailEvent,
  extra: Partial<EventTimelineEntry> = {},
): EventTimelineEntry {
  return {
    mailId,
    at,
    dir,
    event,
    origin: extra.origin ?? "stored",
    source: extra.source ?? "ai",
    ...extra,
  };
}

function facts(timeline: EventTimelineEntry[]): ItemFacts {
  const outs = timeline.filter((x) => x.dir === "out");
  const ins = timeline.filter((x) => x.dir === "in");
  return {
    lastOutboundAt: outs.at(-1)?.at ?? null,
    lastInboundAt: ins.at(-1)?.at ?? null,
    lastMeaningfulInboundAt: ins.at(-1)?.at ?? null,
    waitingUntil: null,
    lastIntent: null,
    followUpCount: timeline.filter((x) => x.event === "follow_up_sent").length,
    hasOutbound: outs.length > 0,
    hasInbound: ins.length > 0,
    isThanksSent: timeline.some((x) => x.event === "thanks_sent"),
    fromResearchOnly: false,
    lastInboundSubject: null,
    lastInboundBody: null,
    lastInboundFrom: null,
    flags: {
      autoReply: false,
      ackOnly: false,
      clickAction: false,
      rejected: timeline.some((x) => x.event === "rejection"),
      thanksSent: timeline.some((x) => x.event === "thanks_sent"),
      bounced: false,
      unverified: false,
      mailAfterClose: false,
    },
    aiStatus: null,
    timeline,
  };
}

function status(
  timeline: EventTimelineEntry[],
  now = NOW,
  extra: Partial<Parameters<typeof effective>[0]> = {},
): EffectiveResult {
  return effective({
    facts: facts(timeline),
    userState: "active",
    ...SETTINGS,
    now,
    ...extra,
  });
}

/** Real Beispiel AG (#8) events_json shape. */
const ITEM8: EventTimelineEntry[] = [
  e(18, "2026-09-21T09:02:14.000Z", "in", "ack"),
  e(19, "2026-09-21T09:03:19.000Z", "in", "ack"),
  e(38, "2026-09-21T10:55:33.000Z", "in", "info_request"),
  e(40, "2026-09-21T11:41:21.000Z", "out", "other"),
  e(41, "2026-09-21T12:13:11.000Z", "in", "interview_invite"),
  e(44, "2026-09-21T12:44:06.000Z", "in", "other"),
  e(69, "2026-09-23T07:18:52.000Z", "in", "rejection"),
  e(214, "2026-10-02T07:05:12.000Z", "in", "rejection"),
  e(215, "2026-10-02T07:39:08.000Z", "out", "other"),
  e(268, "2026-10-08T07:30:13.000Z", "out", "follow_up_sent"),
  e(270, "2026-10-08T08:05:17.000Z", "in", "other"),
  e(271, "2026-10-08T08:15:05.000Z", "out", "thanks_sent"),
];

describe("rejection latch", () => {
  it("closes #8 after thanks_sent (feedback chase must not reopen)", () => {
    assert.equal(status(ITEM8).status, "closed");
    assert.equal(status(ITEM8).sentiment, "negative");
  });

  it("keeps rejected when we ask for feedback and get other inbound (no thanks yet)", () => {
    const tl = [
      e(1, "2026-10-02T07:00:00.000Z", "in", "rejection"),
      e(2, "2026-10-02T08:00:00.000Z", "out", "other"),
      e(3, "2026-10-08T08:00:00.000Z", "in", "other"),
    ];
    // aftermath 8 Oct + 10 days = 18 Oct; now 21 Oct → closed
    assert.equal(status(tl).status, "closed");
    // Before close window ends → still rejected
    assert.equal(
      status(tl, Date.parse("2026-10-10T12:00:00.000Z")).status,
      "rejected",
    );
  });

  it("does not clear latch on outbound other / follow_up_sent", () => {
    const s = foldTimeline([
      e(1, "2026-10-01T00:00:00.000Z", "in", "rejection"),
      e(2, "2026-10-02T00:00:00.000Z", "out", "other"),
      e(3, "2026-10-03T00:00:00.000Z", "out", "follow_up_sent"),
    ]);
    assert.ok(s.rejectedAt);
    assert.equal(s.trailingFollowUps, 0);
    assert.equal(s.aftermathAt, "2026-10-03T00:00:00.000Z");
  });

  it("reopens on application_sent", () => {
    const s = foldTimeline([
      e(1, "2026-10-01T00:00:00.000Z", "in", "rejection"),
      e(2, "2026-10-05T00:00:00.000Z", "out", "application_sent"),
    ]);
    assert.equal(s.rejectedAt, null);
  });

  it("reopens on AI interview_invite, not on fallback info_request", () => {
    const reopen = foldTimeline([
      e(1, "2026-10-01T00:00:00.000Z", "in", "rejection"),
      e(2, "2026-10-05T00:00:00.000Z", "in", "interview_invite"),
    ]);
    assert.equal(reopen.rejectedAt, null);
    assert.equal(reopen.pending?.event, "interview_invite");

    const keep = foldTimeline([
      e(1, "2026-10-01T00:00:00.000Z", "in", "rejection"),
      e(2, "2026-10-05T00:00:00.000Z", "in", "info_request", {
        origin: "intent",
        source: undefined,
      }),
    ]);
    assert.ok(keep.rejectedAt);
    assert.equal(keep.pending, null);
  });

  it("talent-pool other inbound stays rejected", () => {
    const tl = [
      e(1, "2026-10-15T00:00:00.000Z", "in", "rejection"),
      e(2, "2026-10-16T00:00:00.000Z", "in", "other"),
    ];
    assert.equal(status(tl).status, "rejected");
  });
});

describe("offer handling", () => {
  it("withdrawn after offer → closed", () => {
    const tl = [
      e(1, "2026-10-01T00:00:00.000Z", "in", "offer"),
      e(2, "2026-10-02T00:00:00.000Z", "out", "withdrawn"),
    ];
    assert.equal(status(tl).status, "closed");
  });

  it("reply after offer → waiting (not follow_up_due)", () => {
    const tl = [
      e(1, "2026-10-01T00:00:00.000Z", "in", "offer"),
      e(2, "2026-10-02T00:00:00.000Z", "out", "other"),
    ];
    const r = status(tl);
    assert.equal(r.status, "waiting");
    assert.equal(r.waitingOn, "them");
    assert.equal(r.sentiment, "positive");
  });

  it("pending offer without reply → needs_reply", () => {
    const tl = [e(1, "2026-10-01T00:00:00.000Z", "in", "offer")];
    assert.equal(status(tl).status, "needs_reply");
  });
});

describe("resilience", () => {
  it("sorts equal timestamps with inbound before outbound", () => {
    const a = e(2, "2026-10-01T00:00:00.000Z", "out", "other");
    const b = e(1, "2026-10-01T00:00:00.000Z", "in", "rejection");
    assert.ok(compareTimelineEntries(b, a) < 0);
  });

  it("clamps future-dated outbound silence anchor to now", () => {
    const tl = [
      e(1, "2026-10-01T00:00:00.000Z", "out", "application_sent"),
      e(2, "2027-01-01T00:00:00.000Z", "out", "follow_up_sent"),
    ];
    // Without clamp, follow_up would be far in the future → in_progress forever.
    // With clamp to NOW, silence from now → still in_progress (5 days not passed).
    assert.equal(status(tl).status, "in_progress");
  });

  it("sets mailAfterClose when human mail arrives after thanks close", () => {
    const tl = [
      e(1, "2026-10-01T00:00:00.000Z", "in", "rejection"),
      e(2, "2026-10-02T00:00:00.000Z", "out", "thanks_sent"),
      e(3, "2026-10-10T00:00:00.000Z", "in", "other"),
    ];
    const r = status(tl);
    assert.equal(r.status, "closed");
    assert.equal(r.mailAfterClose, true);
  });

  it("marks low-confidence AI rejection as unverified", () => {
    const tl = [
      e(1, "2026-10-01T00:00:00.000Z", "in", "rejection", {
        confidence: LOW_CONFIDENCE - 0.1,
      }),
    ];
    assert.equal(timelineUnverified(tl), true);
  });

  it("inactive user_state stays inactive even with new mail in timeline", () => {
    const r = effective({
      facts: facts([
        e(1, "2026-10-20T00:00:00.000Z", "in", "info_request"),
      ]),
      userState: "inactive",
      ...SETTINGS,
      now: NOW,
    });
    assert.equal(r.status, "inactive");
  });
});

describe("position groups", () => {
  it("clusters similar position labels", () => {
    const c = clusterPositions([
      "Senior Frontend",
      "Senior-Frontend-Entwickler",
      "Full-Stack Developer",
    ]);
    assert.ok(c.size >= 2);
  });

  it("keeps needs_reply when only one of two roles is rejected", () => {
    const tl = [
      e(1, "2026-09-21T12:00:00.000Z", "in", "interview_invite", {
        pos: "Senior Frontend",
      }),
      e(2, "2026-09-23T07:00:00.000Z", "in", "rejection", {
        pos: "Full-Stack Developer",
      }),
    ];
    assert.equal(status(tl).status, "needs_reply");
  });

  it("closes when both roles rejected and thanks sent on one", () => {
    const tl = [
      e(1, "2026-09-23T07:00:00.000Z", "in", "rejection", {
        pos: "Full-Stack",
      }),
      e(2, "2026-10-02T07:00:00.000Z", "in", "rejection", {
        pos: "Senior Frontend",
      }),
      e(3, "2026-10-08T08:00:00.000Z", "out", "thanks_sent", {
        pos: "Senior Frontend",
      }),
    ];
    // Full-Stack still latched rejected → merge picks rejected over closed
    // unless Full-Stack also past close window. aftermath=sep23 + 10d = oct3; now oct21 → closed
    assert.equal(status(tl).status, "closed");
  });
});

describe("scheduledAt interview wait", () => {
  it("waits until scheduled day end", () => {
    const tl = [
      e(1, "2026-10-01T00:00:00.000Z", "in", "interview_invite", {
        scheduledAt: "2026-10-28",
      }),
      e(2, "2026-10-02T00:00:00.000Z", "out", "other"),
    ];
    // Pending cleared by outbound; scheduledUntil still set → waiting
    const r = status(tl);
    assert.equal(r.status, "waiting");
    assert.equal(r.waitingUntil, "2026-10-28");
  });
});
