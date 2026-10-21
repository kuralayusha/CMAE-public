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
import { parseFlagsJson } from "./derive/flags";
import { buildGmailThreadUrls } from "./gmail-links";
import {
  getLiveDraftAnyKind,
  toPendingInfo,
} from "./gmail-drafts-store";
import { reconcileDraftFlagsForRow } from "./pending-draft";
import { loadRecipientsForItem } from "./recipients";
import { getSyncState } from "./sync";
import {
  indexedDraftContentHash,
  isWorkspaceFolderPresent,
} from "./workspace-index";
import {
  STATUS_ORDER,
  type DraftKind,
  type TrackerListItem,
  type TrackerRowWarning,
  type TrackerSection,
  type TrackerSentiment,
  type TrackerStatus,
  type WaitingOn,
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
  gmailUrls: string[],
  flags: {
    hasFollowUpDraft: boolean;
    hasThanksDraft: boolean;
    hasReplyDraft: boolean;
  },
  statusSettings: StatusSettings,
  nowMs?: number,
  gmailAddress?: string | null,
): TrackerListItem & { nextTransitionAt: string | null } {
  // Computed-on-read: follow-up / OOO transitions without waiting for sync.
  const facts = factsFromItemRow(row);
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
  const warnings = rowWarnings(
    row,
    live ? (live.kind as DraftKind) : null,
    live?.contentHash || null,
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
    hasFollowUpDraft: flags.hasFollowUpDraft,
    hasThanksDraft: flags.hasThanksDraft,
    hasReplyDraft: flags.hasReplyDraft,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
    lastActivityAt,
    statusLabel: statusTitle(status),
    gmailUrls,
    waitingUntil: parseWaitingUntil(row.notesJson, row.waitingUntil),
    pendingGmailDraft: live ? toPendingInfo(live, gmailAddress) : null,
    recipientOptions: recipients.candidates,
    recommendedTo: recipients.recommended,
    userVersion: row.userVersion || 1,
    warnings: warnings.length ? warnings : undefined,
    unverified: parseFlagsJson(row.flagsJson).unverified || undefined,
    channel: row.channel,
    nextTransitionAt: resolved.nextTransitionAt,
  };
}

function gmailUrlsByItemId(): Map<number, string[]> {
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

export function listTrackerSections(opts?: { now?: number }): {
  sections: TrackerSection[];
  sync: ReturnType<typeof getSyncState>;
  total: number;
  /** Earliest clock-only status change across rows (validUntil cap). */
  nextTransitionAt: string | null;
} {
  const db = getDb();
  const urlsMap = gmailUrlsByItemId();
  const settings = getSettingsRow();
  const statusSettings = statusSettingsFromRow(settings);
  const gmailAddress = settings?.gmailAddress?.trim() || null;
  let nextTransitionAt: string | null = null;
  const rows = db
    .select()
    .from(trackerItems)
    .all()
    .filter((row) => !row.deletedAt)
    .map((row) => {
      // Index-derived flags only — no fs, never persist on GET.
      const flags = reconcileDraftFlagsForRow(row, { persist: false });
      const { nextTransitionAt: rowNext, ...item } = mapRow(
        row,
        urlsMap.get(row.id) || [],
        flags,
        statusSettings,
        opts?.now,
        gmailAddress,
      );
      if (rowNext && (!nextTransitionAt || rowNext < nextTransitionAt)) {
        nextTransitionAt = rowNext;
      }
      return item as TrackerListItem;
    });
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

  return {
    sections,
    sync: getSyncState(),
    total: rows.length,
    nextTransitionAt,
  };
}
