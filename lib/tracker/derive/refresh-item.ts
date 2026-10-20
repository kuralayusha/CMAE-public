/**
 * Recompute and persist fact columns for one item (never touches user columns).
 */

import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  mailAssignments,
  mailMessages,
  trackerItemMails,
  trackerItems,
} from "@/lib/db/schema";
import type { MailIntentMap } from "../mail-kind";
import {
  parsePendingGmailDraft,
  shouldClearPendingGmailDraft,
} from "../pending-draft";
import { effective } from "./effective";
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
  let mailIds = assigns.map((a) => a.mailId);
  if (!mailIds.length) {
    mailIds = db
      .select()
      .from(trackerItemMails)
      .where(eq(trackerItemMails.itemId, itemId))
      .all()
      .map((l) => l.mailId);
  }
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
      goneAt: m.goneAt,
    }));
}

/**
 * Persist facts + status_cached. Does not write user_state / selected_recipient.
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
  const facts = computeFacts({
    assignedMails: assigned,
    intents,
    researchCandidate: Boolean(item.researchJobId || item.originResearchJobId),
    priorFollowUpCount: item.followUpCount,
    aiStatusHint: item.aiStatus || (item.status !== "inactive" ? item.status : null),
  });

  const userState =
    item.userState || (item.status === "inactive" ? "inactive" : "active");

  const resolved = effective({
    facts,
    userState,
    followUpDays,
    now: opts?.now,
  });

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
      // Fact columns
      aiStatus: facts.aiStatus || resolved.status,
      lastMeaningfulInboundAt: facts.lastMeaningfulInboundAt,
      waitingUntil: facts.waitingUntil || resolved.waitingUntil,
      lastIntent: facts.lastIntent,
      flagsJson: factsToFlagsJson(facts.flags),
      needsClassification: opts?.needsClassification
        ? 1
        : item.needsClassification,
      derivedVersion: (item.derivedVersion || 1) + 1,
      derivedAt: now,
      // Cached status for legacy readers (inactive overlay honored)
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
