import { inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  mailMessages,
  trackerItemMails,
  trackerItems,
} from "@/lib/db/schema";
import { getSettingsRow } from "@/lib/settings/service";
import { buildGmailThreadUrls } from "./gmail-links";
import { getSyncState } from "./sync";
import {
  STATUS_ORDER,
  STATUS_TITLES,
  type TrackerListItem,
  type TrackerSection,
  type TrackerSentiment,
  type TrackerStatus,
  type WaitingOn,
} from "./types";

function parseWaitingUntil(notesJson: string | null): string | null {
  if (!notesJson) return null;
  try {
    const parsed = JSON.parse(notesJson) as { waitingUntil?: string | null };
    return parsed.waitingUntil ? String(parsed.waitingUntil).slice(0, 10) : null;
  } catch {
    return null;
  }
}

function mapRow(
  row: typeof trackerItems.$inferSelect,
  gmailUrls: string[],
): TrackerListItem {
  const status = row.status as TrackerStatus;
  const lastActivityAt =
    [row.lastInboundAt, row.lastOutboundAt]
      .filter(Boolean)
      .sort()
      .at(-1) || row.updatedAt;

  return {
    id: row.id,
    company: row.company,
    position: row.position,
    status,
    sentiment: (row.sentiment as TrackerSentiment | null) || null,
    waitingOn: (row.waitingOn as WaitingOn | null) || null,
    followUpCount: row.followUpCount,
    lastOutboundAt: row.lastOutboundAt,
    lastInboundAt: row.lastInboundAt,
    nextFollowUpAt: row.nextFollowUpAt,
    ignored: Boolean(row.ignored),
    workspaceFolder: row.workspaceFolder,
    searchJobId: row.searchJobId,
    primaryTo: row.primaryTo,
    notesJson: row.notesJson,
    hasFollowUpDraft: Boolean(row.hasFollowUpDraft),
    hasThanksDraft: Boolean(row.hasThanksDraft),
    hasReplyDraft: Boolean(row.hasReplyDraft),
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
    lastActivityAt,
    statusLabel: STATUS_TITLES[status] || status,
    gmailUrls,
    waitingUntil: parseWaitingUntil(row.notesJson),
  };
}

function gmailUrlsByItemId(): Map<number, string[]> {
  const db = getDb();
  const links = db.select().from(trackerItemMails).all();
  if (!links.length) return new Map();

  const mailIds = [...new Set(links.map((l) => l.mailId))];
  const mails = db
    .select({
      id: mailMessages.id,
      threadId: mailMessages.threadId,
      messageId: mailMessages.messageId,
      dateIso: mailMessages.dateIso,
    })
    .from(mailMessages)
    .where(inArray(mailMessages.id, mailIds))
    .all();
  const mailById = new Map(mails.map((m) => [m.id, m]));

  const mailsByItem = new Map<
    number,
    { threadId: string | null; messageId: string; dateIso: string }[]
  >();
  for (const link of links) {
    const mail = mailById.get(link.mailId);
    if (!mail) continue;
    const list = mailsByItem.get(link.itemId) || [];
    list.push({
      threadId: mail.threadId,
      messageId: mail.messageId,
      dateIso: mail.dateIso,
    });
    mailsByItem.set(link.itemId, list);
  }

  const settings = getSettingsRow();
  const authEmail =
    settings?.gmailAddress?.trim() || null;

  const out = new Map<number, string[]>();
  for (const [itemId, itemMails] of mailsByItem) {
    out.set(itemId, buildGmailThreadUrls(itemMails, authEmail));
  }
  return out;
}

function sortWithinSection(a: TrackerListItem, b: TrackerListItem): number {
  if (a.status === "needs_reply" && b.status === "needs_reply") {
    const rank = (s: TrackerSentiment | null) =>
      s === "positive" ? 0 : s === "neutral" ? 1 : s === "negative" ? 2 : 3;
    const d = rank(a.sentiment) - rank(b.sentiment);
    if (d !== 0) return d;
  }
  const ta = a.lastActivityAt || "";
  const tb = b.lastActivityAt || "";
  return tb.localeCompare(ta);
}

export function listTrackerSections(): {
  sections: TrackerSection[];
  sync: ReturnType<typeof getSyncState>;
  total: number;
} {
  const db = getDb();
  const urlsMap = gmailUrlsByItemId();
  const rows = db
    .select()
    .from(trackerItems)
    .all()
    .map((row) => mapRow(row, urlsMap.get(row.id) || []));
  const byStatus = new Map<TrackerStatus, TrackerListItem[]>();
  for (const s of STATUS_ORDER) byStatus.set(s, []);
  for (const row of rows) {
    const list = byStatus.get(row.status) || [];
    list.push(row);
    byStatus.set(row.status, list);
  }

  const sections: TrackerSection[] = [];
  for (const status of STATUS_ORDER) {
    const items = (byStatus.get(status) || []).sort(sortWithinSection);
    if (!items.length) continue;
    sections.push({
      status,
      title: STATUS_TITLES[status],
      items,
    });
  }

  return {
    sections,
    sync: getSyncState(),
    total: rows.length,
  };
}
