/**
 * Recompute and persist fact columns for one item (never touches user columns).
 */

import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  conversationAnalysis,
  mailAssignments,
  mailConversations,
  mailEvents,
  mailIntents,
  mailMessages,
  trackerItems,
} from "@/lib/db/schema";
import { getSettingsRow } from "@/lib/settings/service";
import { normalizeIntent, type MailIntentMap } from "../mail-kind";
import {
  parsePendingGmailDraft,
  shouldClearPendingGmailDraft,
} from "../pending-draft";
import { statusSettingsFromRow } from "../status-constants";
import { effective, foldTimeline } from "./effective";
import {
  normalizeMailEvent,
  serializeTimeline,
  type MailEventSource,
  type StoredMailEvent,
} from "./events";
import {
  computeFacts,
  factsToFlagsJson,
  type FactMail,
} from "./facts";

function loadAssignedMails(itemId: number): FactMail[] {
  const db = getDb();
  const assigns = db
    .select()
    .from(mailAssignments)
    .where(eq(mailAssignments.itemId, itemId))
    .all();
  const mailIds = assigns.map((a) => a.mailId);
  if (!mailIds.length) return [];
  return db
    .select()
    .from(mailMessages)
    .where(inArray(mailMessages.id, mailIds))
    .all()
    .map((m) => ({
      id: m.id,
      folder: m.folder,
      fromAddr: m.fromAddr,
      toAddr: m.toAddr,
      subject: m.subject,
      dateIso: m.internalDate || m.dateIso,
      bodyText: m.bodyText,
      snippet: m.snippet,
      threadId: m.threadId,
      messageId: m.messageId,
      inReplyTo: m.inReplyTo,
      referencesHdr: m.referencesHdr,
      direction: m.direction,
      goneAt: m.goneAt,
    }));
}

/** Cached intents from mail_intents, overlaid by the caller's fresher map. */
function loadIntents(mailIds: number[], overlay: MailIntentMap): MailIntentMap {
  const map: MailIntentMap = new Map();
  if (mailIds.length) {
    for (const row of getDb()
      .select()
      .from(mailIntents)
      .where(inArray(mailIntents.mailId, mailIds))
      .all()) {
      map.set(row.mailId, {
        mailId: row.mailId,
        intent: normalizeIntent(row.intent),
        waitingUntil: row.waitingUntil,
      });
    }
  }
  for (const [id, rec] of overlay) {
    if (mailIds.includes(id)) map.set(id, rec);
  }
  return map;
}

function loadStoredEvents(mailIds: number[]): Map<number, StoredMailEvent> {
  const map = new Map<number, StoredMailEvent>();
  if (!mailIds.length) return map;
  for (const row of getDb()
    .select()
    .from(mailEvents)
    .where(inArray(mailEvents.mailId, mailIds))
    .all()) {
    const event = normalizeMailEvent(row.event);
    if (event) {
      map.set(row.mailId, {
        event,
        waitingUntil: row.waitingUntil,
        source: row.source as MailEventSource,
        confidence: row.confidence ?? null,
        scheduledAt: row.scheduledAt ?? null,
      });
    }
  }
  return map;
}

/** mailId → triage position for multi-role rejection groups. */
function loadPositionsByMail(mailIds: number[]): Map<number, string | null> {
  const out = new Map<number, string | null>();
  if (!mailIds.length) return out;
  const db = getDb();
  const convRows = db
    .select({
      id: mailConversations.id,
      mailIds: mailConversations.mailIds,
      position: conversationAnalysis.position,
    })
    .from(mailConversations)
    .leftJoin(
      conversationAnalysis,
      eq(conversationAnalysis.conversationId, mailConversations.id),
    )
    .all();
  const wanted = new Set(mailIds);
  for (const row of convRows) {
    let ids: number[] = [];
    try {
      ids = JSON.parse(row.mailIds || "[]") as number[];
    } catch {
      ids = [];
    }
    const pos = row.position?.trim() || null;
    for (const id of ids) {
      if (wanted.has(id)) out.set(id, pos);
    }
  }
  return out;
}

/**
 * Persist facts + cached status. Does not write user_state / selected_recipient,
 * and never writes the time-dependent resolved status into ai_status.
 */
export function refreshItemFacts(
  itemId: number,
  intents: MailIntentMap,
  followUpDays: number,
  opts?: { needsClassification?: boolean; now?: number },
): void {
  const db = getDb();
  const item = db
    .select()
    .from(trackerItems)
    .where(eq(trackerItems.id, itemId))
    .get();
  if (!item || item.deletedAt) return;

  const assigned = loadAssignedMails(itemId);
  const mailIds = assigned.map((m) => m.id);
  const positionByMail = loadPositionsByMail(mailIds);
  let facts = computeFacts({
    assignedMails: assigned,
    intents: loadIntents(mailIds, intents),
    events: loadStoredEvents(mailIds),
    researchCandidate: Boolean(item.researchJobId || item.originResearchJobId),
    aiStatusHint: item.aiStatus,
    positionByMail,
  });

  const userState =
    item.userState || (item.status === "inactive" ? "inactive" : "active");

  const statusSettings = statusSettingsFromRow(getSettingsRow());
  const resolved = effective({
    facts,
    userState,
    followUpDays,
    rejectionCloseDays: statusSettings.rejectionCloseDays,
    staleCloseDays: statusSettings.staleCloseDays,
    now: opts?.now,
  });
  const mailAfterClose =
    resolved.mailAfterClose || foldTimeline(facts.timeline).mailAfterClose;
  facts = {
    ...facts,
    flags: { ...facts.flags, mailAfterClose },
  };

  let notesObj: Record<string, unknown> = {};
  try {
    notesObj = item.notesJson
      ? (JSON.parse(item.notesJson) as Record<string, unknown>)
      : {};
  } catch {
    notesObj = {};
  }

  const pending = parsePendingGmailDraft(item.notesJson);
  const pendingCleared = shouldClearPendingGmailDraft(
    pending,
    facts.lastOutboundAt,
  );
  if (pendingCleared) delete notesObj.pendingGmailDraft;

  notesObj = {
    ...notesObj,
    waitingUntil: resolved.waitingUntil || facts.waitingUntil,
    isAutoReply: facts.flags.autoReply,
    isAckOnly: facts.flags.ackOnly,
    isClickAction: facts.flags.clickAction,
    lastMailIntent: facts.lastIntent,
    lastInboundSubject: facts.lastInboundSubject,
    lastInboundBody: facts.lastInboundBody,
    lastInboundFrom: facts.lastInboundFrom,
  };

  // Preserve primaryTo from user selected_recipient when set
  const primaryTo =
    item.selectedRecipient ||
    item.primaryTo ||
    null;

  const now = new Date().toISOString();
  db.update(trackerItems)
    .set({
      // Fact columns (time-independent)
      lastMeaningfulInboundAt: facts.lastMeaningfulInboundAt,
      waitingUntil: facts.waitingUntil || resolved.waitingUntil,
      lastIntent: facts.lastIntent,
      flagsJson: factsToFlagsJson(facts.flags),
      eventsJson: serializeTimeline(facts.timeline),
      needsClassification: opts?.needsClassification
        ? 1
        : item.needsClassification,
      derivedVersion: (item.derivedVersion || 1) + 1,
      derivedAt: now,
      // Cached status for legacy readers; list/detail recompute via effective()
      status: resolved.status,
      sentiment: resolved.sentiment,
      waitingOn: resolved.waitingOn,
      followUpCount: facts.followUpCount,
      lastOutboundAt: facts.lastOutboundAt,
      lastInboundAt: facts.lastInboundAt,
      nextFollowUpAt: resolved.nextFollowUpAt,
      ignored: resolved.ignored ? 1 : 0,
      primaryTo,
      notesJson: JSON.stringify(notesObj),
      updatedAt: now,
    })
    .where(eq(trackerItems.id, itemId))
    .run();
}
