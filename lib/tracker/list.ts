import { inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  mailAssignments,
  mailMessages,
  trackerItems,
} from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { getSettingsRow } from "@/lib/settings/service";
import { statusSettingsFromRow, type StatusSettings } from "./status-constants";
import { effective, factsFromItemRow } from "./derive/effective";
import {
  applySentDraftEvents,
  eventForSentDraftKind,
  type MailEvent,
} from "./derive/events";
import { parseFlagsJson } from "./derive/flags";
import { buildGmailThreadPreviews } from "./gmail-links";
import { dropPreparedFilesForSentDraft } from "./clear-prepared";
import {
  getLiveDraftAnyKind,
  listSentDraftSignals,
  toPendingInfo,
  type SentDraftSignal,
} from "./gmail-drafts-store";
import { reconcileDraftFlagsForRow } from "./pending-draft";
import { loadRecipientsForItem } from "./recipients";
import { getSyncState } from "./sync";
import {
  indexedDraftContentHash,
  isWorkspaceFolderPresent,
} from "./workspace-index";
import { listRecentEntries } from "./recent";
import {
  STATUS_ORDER,
  type DraftKind,
  type TrackerListItem,
  type TrackerRecentItem,
  type TrackerRowWarning,
  type TrackerSection,
  type TrackerSentiment,
  type TrackerStatus,
  type WaitingOn,
  type GmailThreadPreview,
} from "./types";

function rowWarnings(
  row: typeof trackerItems.$inferSelect,
  liveKind: DraftKind | null,
  liveContentHash: string | null,
): TrackerRowWarning[] {
  const out: TrackerRowWarning[] = [];
  if (row.workspaceFolder) {
    const present = isWorkspaceFolderPresent(row.workspaceFolder);
    if (present === false) {
      out.push({
        code: "folderMissing",
        message: t("tracker.warning.folderMissing"),
      });
    }
  }
  if (liveKind && liveContentHash) {
    const indexed = indexedDraftContentHash(
      row.workspaceFolder,
      liveKind,
      row.followUpCount,
    );
    if (indexed && indexed !== liveContentHash) {
      out.push({
        code: "draftContentMismatch",
        message: t("tracker.warning.draftContentMismatch"),
      });
    }
  }
  return out;
}

function statusTitle(status: TrackerStatus): string {
  return t(`tracker.section.${status}`);
}

function parseWaitingUntil(
  notesJson: string | null,
  columnWaitingUntil: string | null,
): string | null {
  if (columnWaitingUntil) return columnWaitingUntil.slice(0, 10);
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
  gmailThreads: GmailThreadPreview[],
  flags: {
    hasApplicationDraft: boolean;
    hasFollowUpDraft: boolean;
    hasThanksDraft: boolean;
    hasReplyDraft: boolean;
  },
  statusSettings: StatusSettings,
  sentByMail: ReadonlyMap<number, MailEvent>,
  nowMs?: number,
  gmailAddress?: string | null,
): TrackerListItem & { nextTransitionAt: string | null } {
  // Computed-on-read: follow-up / OOO transitions without waiting for sync.
  const baseFacts = factsFromItemRow(row);
  const facts = {
    ...baseFacts,
    timeline: applySentDraftEvents(baseFacts.timeline, sentByMail),
  };
  const userState =
    row.userState || (row.status === "inactive" ? "inactive" : "active");
  const resolved = effective({
    facts,
    userState,
    ...statusSettings,
    now: nowMs,
  });
  const status = resolved.status;
  // Only real mail counts as activity — draft/prepare/notes must not bump this.
  // Fallback to createdAt when nothing has been sent or received yet.
  const lastActivityAt =
    [row.lastInboundAt, row.lastOutboundAt]
      .filter(Boolean)
      .sort()
      .at(-1) || row.createdAt;

  const recipients = loadRecipientsForItem(row);
  const live = getLiveDraftAnyKind(row.id);
  // `creating` is not ready yet — keep chip on "research done" / spinner via
  // item_ops until APPEND finishes and state becomes present|unknown.
  const readyLive =
    live && live.state !== "creating" ? live : null;
  const warnings = rowWarnings(
    row,
    readyLive ? (readyLive.kind as DraftKind) : null,
    readyLive?.contentHash || null,
  );
  return {
    id: row.id,
    company: row.company,
    position: row.position,
    status,
    sentiment:
      (resolved.sentiment as TrackerSentiment | null) ||
      (row.sentiment as TrackerSentiment | null) ||
      null,
    waitingOn: (resolved.waitingOn as WaitingOn | null) || null,
    followUpCount: row.followUpCount,
    lastOutboundAt: row.lastOutboundAt,
    lastInboundAt: row.lastInboundAt,
    nextFollowUpAt: resolved.nextFollowUpAt,
    ignored: resolved.ignored,
    workspaceFolder: row.workspaceFolder,
    researchJobId: row.researchJobId,
    primaryTo: row.selectedRecipient || row.primaryTo,
    notesJson: row.notesJson,
    hasApplicationDraft: flags.hasApplicationDraft,
    hasFollowUpDraft: flags.hasFollowUpDraft,
    hasThanksDraft: flags.hasThanksDraft,
    hasReplyDraft: flags.hasReplyDraft,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
    lastActivityAt,
    statusLabel:
      status === "waiting" && resolved.waitingReason === "interview"
        ? t("tracker.chip.interview")
        : statusTitle(status),
    gmailUrls: gmailThreads.map((thread) => thread.url),
    gmailThreads,
    waitingUntil:
      resolved.waitingUntil ||
      parseWaitingUntil(row.notesJson, row.waitingUntil),
    pendingGmailDraft: readyLive
      ? toPendingInfo(readyLive, gmailAddress)
      : null,
    recipientOptions: recipients.candidates,
    recommendedTo: recipients.recommended,
    userVersion: row.userVersion || 1,
    warnings: warnings.length ? warnings : undefined,
    unverified: parseFlagsJson(row.flagsJson).unverified || undefined,
    mailAfterClose:
      resolved.mailAfterClose ||
      parseFlagsJson(row.flagsJson).mailAfterClose ||
      undefined,
    waitingReason: resolved.waitingReason || undefined,
    channel: row.channel,
    nextTransitionAt: resolved.nextTransitionAt,
  };
}

function gmailThreadsByItemId(): Map<number, GmailThreadPreview[]> {
  const db = getDb();
  const links = db
    .select()
    .from(mailAssignments)
    .all()
    .map((a) => ({ itemId: a.itemId, mailId: a.mailId }));
  if (!links.length) return new Map();

  const mailIds = [...new Set(links.map((l) => l.mailId))];
  const mails = db
    .select({
      id: mailMessages.id,
      threadId: mailMessages.threadId,
      messageId: mailMessages.messageId,
      dateIso: mailMessages.dateIso,
      subject: mailMessages.subject,
      fromAddr: mailMessages.fromAddr,
      toAddr: mailMessages.toAddr,
      folder: mailMessages.folder,
      snippet: mailMessages.snippet,
    })
    .from(mailMessages)
    .where(inArray(mailMessages.id, mailIds))
    .all();
  const mailById = new Map(mails.map((m) => [m.id, m]));

  const mailsByItem = new Map<number, (typeof mails)[number][]>();
  for (const link of links) {
    const mail = mailById.get(link.mailId);
    if (!mail) continue;
    const list = mailsByItem.get(link.itemId) || [];
    list.push(mail);
    mailsByItem.set(link.itemId, list);
  }

  const settings = getSettingsRow();
  const authEmail = settings?.gmailAddress?.trim() || null;

  const out = new Map<number, GmailThreadPreview[]>();
  for (const [itemId, itemMails] of mailsByItem) {
    out.set(
      itemId,
      buildGmailThreadPreviews(itemMails, authEmail, authEmail),
    );
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

export function listTrackerSections(opts?: { now?: number }): {
  sections: TrackerSection[];
  recent: TrackerRecentItem[];
  sync: ReturnType<typeof getSyncState>;
  total: number;
  /** Earliest clock-only status change across rows (validUntil cap). */
  nextTransitionAt: string | null;
} {
  const db = getDb();
  const threadsMap = gmailThreadsByItemId();
  const settings = getSettingsRow();
  const statusSettings = statusSettingsFromRow(settings);
  const gmailAddress = settings?.gmailAddress?.trim() || null;
  const sentDrafts = listSentDraftSignals();
  const sentByItem = new Map<number, SentDraftSignal[]>();
  const sentByMail = new Map<number, MailEvent>();
  for (const sent of sentDrafts) {
    const list = sentByItem.get(sent.itemId) || [];
    list.push(sent);
    sentByItem.set(sent.itemId, list);
    const event = eventForSentDraftKind(sent.kind);
    if (event) sentByMail.set(sent.mailId, event);
  }
  let nextTransitionAt: string | null = null;
  const rows = db
    .select()
    .from(trackerItems)
    .all()
    .filter((row) => !row.deletedAt)
    .map((row) => {
      for (const sent of sentByItem.get(row.id) || []) {
        dropPreparedFilesForSentDraft({
          workspaceFolder: row.workspaceFolder,
          kind: sent.kind,
          contentHash: sent.contentHash,
        });
      }
      // Flags come from the workspace index. Sent drafts may unlink the matching template first.
      const flags = reconcileDraftFlagsForRow(row, { persist: false });
      const { nextTransitionAt: rowNext, ...item } = mapRow(
        row,
        threadsMap.get(row.id) || [],
        flags,
        statusSettings,
        sentByMail,
        opts?.now,
        gmailAddress,
      );
      if (rowNext && (!nextTransitionAt || rowNext < nextTransitionAt)) {
        nextTransitionAt = rowNext;
      }
      return item as TrackerListItem;
    });
  const byId = new Map(rows.map((r) => [r.id, r]));
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
      title: statusTitle(status),
      items,
    });
  }

  const recent: TrackerRecentItem[] = [];
  for (const entry of listRecentEntries({ nowMs: opts?.now })) {
    const item = byId.get(entry.itemId);
    if (!item) continue;
    recent.push({
      ...item,
      recentReason: entry.reason,
      recentTouchedAt: entry.touchedAt,
    });
  }

  return {
    sections,
    recent,
    sync: getSyncState(),
    total: rows.length,
    nextTransitionAt,
  };
}
