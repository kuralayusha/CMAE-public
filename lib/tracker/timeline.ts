import { createHash } from "crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  mailMessages,
  mailAssignments,
  trackerItems,
  trackerTimelines,
} from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { getSettingsRow, getStatusSettings } from "@/lib/settings/service";
import { effective, factsFromItemRow } from "./derive/effective";
import { parseFlagsJson } from "./derive/flags";
import {
  attachMailsToEvents,
  eventsMissingMailLinks,
  generateTimelineSummary,
  TIMELINE_MODEL,
  type TimelineEvent,
  type TimelineMailBrief,
  type TimelineOrigin,
} from "./agents/timeline";
import {
  buildGmailThreadUrls,
  messageIdToGmailUrl,
  threadIdToGmailUrl,
} from "./gmail-links";
import { normalizeMailText } from "./signals";
import type { TrackerStatus } from "./types";

export type LinkedTimelineMail = {
  id: number;
  messageId: string;
  threadId: string | null;
  folder: string;
  role: string;
  fromAddr: string;
  toAddr: string;
  subject: string;
  dateIso: string;
  snippet: string;
  bodyText: string;
  gmailUrl: string;
  /** K1: present when missing from Gmail All Mail / window (fact still kept). */
  goneAt: string | null;
  goneReason: string | null;
};

export type TrackerDetailItem = {
  id: number;
  company: string;
  position: string | null;
  status: TrackerStatus;
  sentiment: string | null;
  waitingOn: string | null;
  primaryTo: string | null;
  researchJobId: string | null;
  workspaceFolder: string | null;
  lastOutboundAt: string | null;
  lastInboundAt: string | null;
  updatedAt: string;
  unverified: boolean;
  channel: string | null;
};

export type TimelinePayload = {
  fingerprint: string;
  events: TimelineEvent[];
  origin: TimelineOrigin;
  locale: string;
  mailCount: number;
  cached: boolean;
  model: string;
  updatedAt: string | null;
};

export function mailFingerprint(messageIds: string[]): string {
  const sorted = [...messageIds].map((id) => id.trim()).filter(Boolean).sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

export function loadTrackerItem(itemId: number): TrackerDetailItem | null {
  const db = getDb();
  const row = db
    .select()
    .from(trackerItems)
    .where(eq(trackerItems.id, itemId))
    .get();
  if (!row) return null;
  // Same computed-on-read status as the list (cached row.status may be stale).
  const resolved = effective({
    facts: factsFromItemRow(row),
    userState:
      row.userState || (row.status === "inactive" ? "inactive" : "active"),
    ...getStatusSettings(),
  });
  return {
    id: row.id,
    company: row.company,
    position: row.position,
    status: resolved.status,
    sentiment: resolved.sentiment || row.sentiment,
    waitingOn: resolved.waitingOn,
    primaryTo: row.primaryTo,
    researchJobId: row.researchJobId,
    workspaceFolder: row.workspaceFolder,
    lastOutboundAt: row.lastOutboundAt,
    lastInboundAt: row.lastInboundAt,
    updatedAt: row.updatedAt,
    unverified: parseFlagsJson(row.flagsJson).unverified,
    channel: row.channel,
  };
}

export function loadLinkedMails(itemId: number): LinkedTimelineMail[] {
  const db = getDb();
  const links = db
    .select()
    .from(mailAssignments)
    .where(eq(mailAssignments.itemId, itemId))
    .all();
  if (!links.length) return [];

  const roleByMail = new Map(links.map((l) => [l.mailId, "inbound" as string]));
  const mailIds = links.map((l) => l.mailId);
  const mails = db
    .select()
    .from(mailMessages)
    .where(inArray(mailMessages.id, mailIds))
    .orderBy(asc(mailMessages.dateIso))
    .all();

  const settings = getSettingsRow();
  const authEmail = settings?.gmailAddress?.trim() || null;

  return mails.map((m) => {
    const gmailUrl = m.threadId
      ? threadIdToGmailUrl(m.threadId, authEmail)
      : messageIdToGmailUrl(m.messageId, authEmail);
    return {
      id: m.id,
      messageId: m.messageId,
      threadId: m.threadId,
      folder: m.folder,
      role: roleByMail.get(m.id) || "inbound",
      fromAddr: m.fromAddr,
      toAddr: m.toAddr,
      subject: m.subject,
      dateIso: m.dateIso,
      snippet: m.snippet,
      bodyText: m.bodyText,
      gmailUrl,
      goneAt: m.goneAt ?? null,
      goneReason: m.goneReason ?? null,
    };
  });
}

export function loadItemGmailUrls(mails: LinkedTimelineMail[]): string[] {
  const settings = getSettingsRow();
  const authEmail = settings?.gmailAddress?.trim() || null;
  return buildGmailThreadUrls(mails, authEmail);
}

function parseEventsJson(raw: string): TimelineEvent[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as TimelineEvent[];
  } catch {
    return [];
  }
}

function toBriefs(mails: LinkedTimelineMail[]): TimelineMailBrief[] {
  return mails.map((m) => ({
    id: m.id,
    folder: m.folder,
    role: m.role,
    fromAddr: m.fromAddr,
    toAddr: m.toAddr,
    subject: normalizeMailText(m.subject || ""),
    dateIso: m.dateIso,
    snippet: normalizeMailText(m.snippet || "").slice(0, 240),
    bodyPreview: normalizeMailText(m.bodyText || m.snippet || "").slice(0, 800),
  }));
}

function emptyTimeline(
  fingerprint: string,
  locale: string,
  mailCount: number,
): TimelinePayload {
  return {
    fingerprint,
    events: [],
    origin: "unknown",
    locale,
    mailCount,
    cached: true,
    model: TIMELINE_MODEL,
    updatedAt: null,
  };
}

export async function getOrCreateTimeline(
  itemId: number,
  opts?: { refresh?: boolean },
): Promise<TimelinePayload> {
  const item = loadTrackerItem(itemId);
  if (!item) {
    throw new Error(t("tracker.error.notFound"));
  }

  const settings = getSettingsRow();
  const locale = settings?.preferredLanguage || "en";
  const mails = loadLinkedMails(itemId);
  const fingerprint = mailFingerprint(mails.map((m) => m.messageId));

  if (!mails.length) {
    return emptyTimeline(fingerprint, locale, 0);
  }

  const db = getDb();
  if (!opts?.refresh) {
    const cached = db
      .select()
      .from(trackerTimelines)
      .where(eq(trackerTimelines.fingerprint, fingerprint))
      .get();
    if (cached && cached.locale === locale) {
      const rawEvents = parseEventsJson(cached.eventsJson);
      const events = attachMailsToEvents(
        rawEvents,
        mails.map((m) => ({
          id: m.id,
          dateIso: m.dateIso,
          folder: m.folder,
          fromAddr: m.fromAddr,
          toAddr: m.toAddr,
          subject: m.subject,
        })),
      );
      // Persist repaired links so old caches (no mailIds) stop re-dumping
      if (eventsMissingMailLinks(rawEvents) && !eventsMissingMailLinks(events)) {
        db.update(trackerTimelines)
          .set({
            eventsJson: JSON.stringify(events),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(trackerTimelines.id, cached.id))
          .run();
      }
      return {
        fingerprint,
        events,
        origin: (cached.origin as TimelineOrigin) || "unknown",
        locale: cached.locale,
        mailCount: cached.mailCount,
        cached: true,
        model: cached.model,
        updatedAt: cached.updatedAt,
      };
    }
  }

  const hasAppOrigin = Boolean(item.researchJobId || item.workspaceFolder);
  const generated = await generateTimelineSummary({
    company: item.company,
    position: item.position,
    locale,
    hasAppOrigin,
    mails: toBriefs(mails),
  });

  const now = new Date().toISOString();
  const existing = db
    .select()
    .from(trackerTimelines)
    .where(eq(trackerTimelines.fingerprint, fingerprint))
    .get();

  if (existing) {
    db.update(trackerTimelines)
      .set({
        company: item.company,
        position: item.position,
        eventsJson: JSON.stringify(generated.events),
        origin: generated.origin,
        model: TIMELINE_MODEL,
        locale,
        mailCount: mails.length,
        updatedAt: now,
      })
      .where(eq(trackerTimelines.id, existing.id))
      .run();
  } else {
    db.insert(trackerTimelines)
      .values({
        fingerprint,
        company: item.company,
        position: item.position,
        eventsJson: JSON.stringify(generated.events),
        origin: generated.origin,
        model: TIMELINE_MODEL,
        locale,
        mailCount: mails.length,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  return {
    fingerprint,
    events: generated.events,
    origin: generated.origin,
    locale,
    mailCount: mails.length,
    cached: false,
    model: TIMELINE_MODEL,
    updatedAt: now,
  };
}
