/**
 * drafts_reconcile job — full Drafts mailbox scan + sent proof.
 * Never called from GET /api/tracker.
 */

import { isDraftCopyLabels } from "@/lib/mail/draft-copy";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, getSqlite } from "@/lib/db/client";
import { bumpTrackerRevision } from "@/lib/db/revision";
import { gmailDrafts, mailMessages, trackerItems } from "@/lib/db/schema";
import { normalizeAccountId } from "@/lib/db/app-meta";
import {
  listAllDraftMetas,
  searchDraftByMessageId,
  type DraftMailboxMeta,
} from "@/lib/mail/gmail-imap-source";
import { t } from "@/lib/i18n/t";
import {
  getGmailCredentials,
  getSettingsRow,
} from "@/lib/settings/service";
import {
  LIVE_DRAFT_STATES,
  listLiveDrafts,
  markDraftDeletedByUser,
  markDraftPresent,
  type GmailDraftRow,
} from "./gmail-drafts-store";
import { dropPreparedFilesForSentDraft } from "./clear-prepared";
import { writeAssignment } from "./derive/assign";
import { refreshItemFacts } from "./derive/refresh-item";
import { reconcileDraftFlagsForRow } from "./pending-draft";
import { statusSettingsFromRow } from "./status-constants";

// Successful Drafts scan + not in mailbox + no sent proof → gone.
// Grace matters: Gmail often removes the Draft before SENT is in mail_messages.
// One check with no delay raced mail_sync and marked sent drafts deleted_by_user.
// (Scan failures use markUnknown; they never call bumpMissing.)
/** Exported for regression tests — do not mark deleted on the first miss. */
export const DRAFT_MISSING_MIN_CHECKS = 2;
export const DRAFT_MISSING_MIN_MS = 90_000;
const MISSING_MIN_CHECKS = DRAFT_MISSING_MIN_CHECKS;
const MISSING_MIN_MS = DRAFT_MISSING_MIN_MS;
const CREATING_TIMEOUT_MS = 10 * 60_000;
const RECONCILE_IMAP_TIMEOUT_MS = 45_000;

export type DraftsReconcileResult = {
  checked: number;
  present: number;
  sent: number;
  deleted: number;
  failed: number;
  unknown: number;
  /** True when sent proof found — caller should trigger mail_sync. */
  triggerMailSync: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __cmaeDraftsReconcile: Promise<DraftsReconcileResult> | null | undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(t("sync.timedOut", { label, ms })));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Normalize Message-ID for Drafts ↔ Sent matching (angle brackets / case). */
export function normalizeDraftMessageId(
  s: string | null | undefined,
): string {
  return (s || "")
    .trim()
    .toLowerCase()
    .replace(/^<|>$/g, "");
}

function normMid(s: string | null | undefined): string {
  return normalizeDraftMessageId(s);
}

function subjectKey(subject: string): string {
  return subject
    .replace(/^(re|aw|wg|fwd|fw)\s*:\s*/gi, "")
    .trim()
    .toLowerCase();
}

function matchLive(
  row: GmailDraftRow,
  live: DraftMailboxMeta[],
): DraftMailboxMeta | null {
  if (row.gmMsgid) {
    const byGm = live.find((m) => m.gmMsgid && m.gmMsgid === row.gmMsgid);
    if (byGm) return byGm;
  }
  const mid = normMid(row.messageIdHdr);
  if (mid && !mid.startsWith("legacy:")) {
    const byMid = live.find((m) => normMid(m.messageIdHdr) === mid);
    if (byMid) return byMid;
  }
  const byId = live.find((m) => m.cmaeDraftId && m.cmaeDraftId === row.id);
  if (byId) return byId;
  if (row.gmThrid) {
    const byThrid = live.find((m) => m.gmThrid && m.gmThrid === row.gmThrid);
    if (byThrid) return byThrid;
  }
  // Legacy unknown: one-shot low-confidence subject (+ optional to) match.
  if (
    row.state === "unknown" &&
    row.messageIdHdr.startsWith("legacy:") &&
    row.subject
  ) {
    const sk = subjectKey(row.subject);
    const candidates = live.filter((m) => {
      if (!subjectsLooseMatch(sk, subjectKey(m.subject))) return false;
      if (!row.toAddr) return true;
      return (m.toAddr || "")
        .toLowerCase()
        .includes(row.toAddr.trim().toLowerCase());
    });
    if (candidates.length === 1) return candidates[0];
  }
  return null;
}

function subjectsLooseMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function findSentProof(row: GmailDraftRow): number | null {
  const sqlite = getSqlite();
  const createdMs = Date.parse(row.createdAt);
  if (!Number.isFinite(createdMs)) return null;

  if (row.gmThrid) {
    const byThrid = sqlite
      .prepare(
        `SELECT id FROM mail_messages
         WHERE gone_at IS NULL
           AND thread_id = ?
           AND (labels_json IS NULL OR labels_json NOT LIKE '%Draft%'
                OR labels_json LIKE '%Sent%')
           AND (
             labels_json LIKE '%\\\\Sent%' OR labels_json LIKE '%Sent%'
             OR folder = 'SENT' OR direction = 'out'
           )
           AND (internal_date >= ? OR date_iso >= ? OR created_at >= ?)
         ORDER BY COALESCE(internal_date, date_iso) DESC
         LIMIT 1`,
      )
      .get(row.gmThrid, row.createdAt, row.createdAt, row.createdAt) as
      | { id: number }
      | undefined;
    if (byThrid?.id) return byThrid.id;
  }

  const mid = normMid(row.messageIdHdr);
  if (mid && !mid.startsWith("legacy:")) {
    const byMid = sqlite
      .prepare(
        `SELECT id FROM mail_messages
         WHERE gone_at IS NULL
           AND lower(replace(replace(trim(message_id), '<', ''), '>', '')) = ?
           AND (labels_json IS NULL OR labels_json NOT LIKE '%Draft%'
                OR labels_json LIKE '%Sent%')
           AND (
             labels_json LIKE '%\\\\Sent%' OR labels_json LIKE '%Sent%'
             OR folder = 'SENT' OR direction = 'out'
           )
         LIMIT 1`,
      )
      .get(mid) as { id: number } | undefined;
    if (byMid?.id) return byMid.id;
  }

  // Application: same recipient + subject outbound after created_at
  if (row.kind === "application" && row.toAddr && row.subject) {
    const sk = subjectKey(row.subject);
    const toNeedle = row.toAddr.trim().toLowerCase();
    const candidates = getDb()
      .select()
      .from(mailMessages)
      .all()
      .filter((m) => {
        if (m.goneAt) return false;
        if (isDraftCopyLabels(m.labelsJson)) return false;
        if (m.folder !== "SENT" && m.direction !== "out") {
          const labels = (m.labelsJson || "").toLowerCase();
          if (!labels.includes("sent")) return false;
        }
        const when = m.internalDate || m.dateIso || m.createdAt;
        if (Date.parse(when) < createdMs) return false;
        if (!subjectsLooseMatch(sk, subjectKey(m.subject || ""))) return false;
        return (m.toAddr || "").toLowerCase().includes(toNeedle);
      });
    if (candidates.length === 1) return candidates[0].id;
    // Prefer the mail already assigned to this item when several match.
    if (candidates.length > 1) {
      const assigned = sqlite
        .prepare(
          `SELECT mail_id AS mailId FROM mail_assignments WHERE item_id = ?`,
        )
        .all(row.itemId) as { mailId: number }[];
      const assignedIds = new Set(assigned.map((a) => a.mailId));
      const onItem = candidates.filter((c) => assignedIds.has(c.id));
      if (onItem.length === 1) return onItem[0].id;
    }
  }

  return null;
}

function applyPresent(row: GmailDraftRow, meta: DraftMailboxMeta): void {
  markDraftPresent(row.id, {
    gmMsgid: meta.gmMsgid,
    gmThrid: meta.gmThrid,
    draftsUid: meta.uid,
    draftsUidvalidity: meta.uidValidity,
    subject: meta.subject || row.subject,
    toAddr: meta.toAddr || row.toAddr,
  });
}

function markSent(row: GmailDraftRow, mailId: number): void {
  getSqlite()
    .prepare(
      `UPDATE gmail_drafts SET
         state = 'sent', sent_mail_id = ?, last_checked_at = ?,
         missing_since = NULL, missing_checks = 0, error = NULL
       WHERE id = ?`,
    )
    .run(mailId, new Date().toISOString(), row.id);

  // Bridge draft → item: without mail_assignments, status stays ready_to_send
  // forever even though gmail_drafts.state is already "sent".
  const mail = getDb()
    .select()
    .from(mailMessages)
    .where(eq(mailMessages.id, mailId))
    .get();
  if (mail) {
    writeAssignment({
      mailId,
      itemId: row.itemId,
      source: "draft",
      confidence: 0.99,
      mail,
    });
  }

  const item = getDb()
    .select()
    .from(trackerItems)
    .where(eq(trackerItems.id, row.itemId))
    .get();
  if (item) {
    dropPreparedFilesForSentDraft({
      workspaceFolder: item.workspaceFolder,
      kind: row.kind as "application" | "follow_up" | "thanks" | "reply",
      contentHash: row.contentHash,
    });
  }

  try {
    const { followUpDays } = statusSettingsFromRow(getSettingsRow());
    refreshItemFacts(row.itemId, new Map(), followUpDays);
  } catch (err) {
    console.error("[drafts-reconcile] refreshItemFacts after sent failed", err);
  }

  bumpTrackerRevision("drafts", "upsert", [row.itemId]);
}

function markDeleted(row: GmailDraftRow): void {
  markDraftDeletedByUser(row.id);
  // Re-enable prepare / create-draft from disk
  const item = getDb()
    .select()
    .from(trackerItems)
    .where(eq(trackerItems.id, row.itemId))
    .get();
  if (item) {
    reconcileDraftFlagsForRow(item);
  }
}

function markFailed(row: GmailDraftRow, error: string): void {
  getSqlite()
    .prepare(
      `UPDATE gmail_drafts SET state = 'failed', error = ?, last_checked_at = ?
       WHERE id = ?`,
    )
    .run(error.slice(0, 500), new Date().toISOString(), row.id);
  bumpTrackerRevision("drafts", "upsert", [row.itemId]);
}

function markUnknown(row: GmailDraftRow, error: string): void {
  if (row.state === "creating") return;
  getSqlite()
    .prepare(
      `UPDATE gmail_drafts SET state = 'unknown', error = ?, last_checked_at = ?
       WHERE id = ? AND state IN ('present', 'unknown')`,
    )
    .run(error.slice(0, 500), new Date().toISOString(), row.id);
  bumpTrackerRevision("drafts", "upsert", [row.itemId]);
}

function bumpMissing(row: GmailDraftRow, nowIso: string): {
  deleted: boolean;
} {
  const missingSince = row.missingSince || nowIso;
  const checks = (row.missingChecks || 0) + 1;
  getSqlite()
    .prepare(
      `UPDATE gmail_drafts SET
         missing_since = ?, missing_checks = ?, last_checked_at = ?
       WHERE id = ?`,
    )
    .run(missingSince, checks, nowIso, row.id);

  const sinceMs = Date.parse(missingSince);
  const ageOk =
    Number.isFinite(sinceMs) && Date.now() - sinceMs >= MISSING_MIN_MS;
  if (checks >= MISSING_MIN_CHECKS && ageOk) {
    markDeleted({ ...row, missingSince, missingChecks: checks });
    return { deleted: true };
  }
  return { deleted: false };
}

/**
 * Pure-ish reconcile against an already-fetched Drafts snapshot.
 * Exported for FakeMailSource / smoke tests.
 */
export function reconcileAgainstLiveMetas(opts: {
  accountId: string;
  live: DraftMailboxMeta[];
  rows?: GmailDraftRow[];
  now?: Date;
  /** Optional per-row Message-ID recovery (creating). */
  recoverCreating?: (
    row: GmailDraftRow,
  ) => DraftMailboxMeta | null | Promise<DraftMailboxMeta | null>;
}): DraftsReconcileResult {
  const accountId = normalizeAccountId(opts.accountId);
  const now = opts.now || new Date();
  const nowIso = now.toISOString();
  const rows =
    opts.rows ||
    listLiveDrafts(accountId).concat(
      getDb()
        .select()
        .from(gmailDrafts)
        .where(eq(gmailDrafts.state, "creating"))
        .all()
        .filter((r) => r.accountId === accountId),
    );
  // Dedupe by id
  const byId = new Map<string, GmailDraftRow>();
  for (const r of rows) byId.set(r.id, r);
  const unique = [...byId.values()].filter((r) =>
    LIVE_DRAFT_STATES.includes(r.state as (typeof LIVE_DRAFT_STATES)[number]),
  );

  const result: DraftsReconcileResult = {
    checked: unique.length,
    present: 0,
    sent: 0,
    deleted: 0,
    failed: 0,
    unknown: 0,
    triggerMailSync: false,
  };

  for (const row of unique) {
    let meta = matchLive(row, opts.live);

    if (!meta && row.state === "creating" && opts.recoverCreating) {
      // sync path may pass async; this sync helper ignores Promise (runner handles).
      const recovered = opts.recoverCreating(row);
      if (recovered && !(recovered instanceof Promise)) meta = recovered;
    }

    if (meta) {
      applyPresent(row, meta);
      result.present += 1;
      continue;
    }

    // creating timeout without mailbox hit
    if (row.state === "creating") {
      const age = now.getTime() - Date.parse(row.createdAt);
      if (Number.isFinite(age) && age >= CREATING_TIMEOUT_MS) {
        markFailed(row, t("sync.draftsNotFoundAfterAppend"));
        result.failed += 1;
      }
      continue;
    }

    const sentId = findSentProof(row);
    if (sentId) {
      markSent(row, sentId);
      result.sent += 1;
      result.triggerMailSync = true;
      continue;
    }

    // Draft left Drafts but SENT is not in DB yet — pull mail before deleting.
    result.triggerMailSync = true;
    const { deleted } = bumpMissing(row, nowIso);
    if (deleted) result.deleted += 1;
  }

  // Recover drafts we wrongly marked deleted/failed before SENT landed in DB.
  recoverTerminalDrafts(accountId, result);

  void result.unknown;
  return result;
}

/**
 * After a premature deleted_by_user (SENT not synced yet), a later reconcile
 * can still promote the row to sent once mail_messages has the outbound.
 */
function recoverTerminalDrafts(
  accountId: string,
  result: DraftsReconcileResult,
): void {
  const terminal = getDb()
    .select()
    .from(gmailDrafts)
    .where(
      and(
        eq(gmailDrafts.accountId, accountId),
        inArray(gmailDrafts.state, ["deleted_by_user", "failed"]),
        isNull(gmailDrafts.sentMailId),
      ),
    )
    .all();
  for (const row of terminal) {
    const sentId = findSentProof(row);
    if (!sentId) continue;
    markSent(row, sentId);
    result.sent += 1;
    result.triggerMailSync = true;
  }
}

async function recoverCreatingAsync(
  creds: { address: string; appPassword: string },
  row: GmailDraftRow,
): Promise<DraftMailboxMeta | null> {
  try {
    return await searchDraftByMessageId(
      creds.address,
      creds.appPassword,
      row.messageIdHdr,
    );
  } catch {
    return null;
  }
}

/**
 * Job entry: IMAP full Drafts scan + state machine.
 */
export async function runDraftsReconcile(opts?: {
  signal?: AbortSignal;
  onProgress?: (kind: "ok" | "err" | "think" | "curl", text: string) => void;
}): Promise<DraftsReconcileResult> {
  if (globalThis.__cmaeDraftsReconcile) {
    return globalThis.__cmaeDraftsReconcile;
  }

  const runPromise = (async (): Promise<DraftsReconcileResult> => {
    const creds = getGmailCredentials();
    if (!creds) {
      return {
        checked: 0,
        present: 0,
        sent: 0,
        deleted: 0,
        failed: 0,
        unknown: 0,
        triggerMailSync: false,
      };
    }
    const accountId = normalizeAccountId(creds.address);
    const liveRows = listLiveDrafts(accountId);
    const recoverable = getDb()
      .select()
      .from(gmailDrafts)
      .where(
        and(
          eq(gmailDrafts.accountId, accountId),
          inArray(gmailDrafts.state, ["deleted_by_user", "failed"]),
          isNull(gmailDrafts.sentMailId),
        ),
      )
      .all();

    // No live drafts: still try to revive wrongly-deleted rows once SENT is in DB.
    if (!liveRows.length) {
      const result: DraftsReconcileResult = {
        checked: 0,
        present: 0,
        sent: 0,
        deleted: 0,
        failed: 0,
        unknown: 0,
        triggerMailSync: false,
      };
      if (recoverable.length) {
        opts?.onProgress?.(
          "think",
          t("sync.draftsReconcileStart", { count: recoverable.length }),
        );
        recoverTerminalDrafts(accountId, result);
      } else {
        opts?.onProgress?.("ok", t("sync.draftsNoLive"));
      }
      if (result.sent) {
        opts?.onProgress?.(
          "ok",
          t("sync.draftsSummary", {
            present: result.present,
            sent: result.sent,
            deleted: result.deleted,
            failed: result.failed,
          }),
        );
      }
      return result;
    }

    opts?.onProgress?.(
      "think",
      t("sync.draftsReconcileStart", { count: liveRows.length }),
    );

    let live: DraftMailboxMeta[] = [];
    try {
      if (opts?.signal?.aborted) throw new Error("aborted");
      live = await withTimeout(
        listAllDraftMetas(creds.address, creds.appPassword),
        RECONCILE_IMAP_TIMEOUT_MS,
        t("sync.draftsScanLabel"),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts?.onProgress?.("err", msg);
      for (const row of liveRows) {
        if (row.state === "present") {
          markUnknown(row, msg);
        }
      }
      // IMAP failed — still try local SENT proof for live + terminal rows.
      const result: DraftsReconcileResult = {
        checked: liveRows.length,
        present: 0,
        sent: 0,
        deleted: 0,
        failed: 0,
        unknown: liveRows.filter((r) => r.state === "present").length,
        triggerMailSync: false,
      };
      for (const row of liveRows) {
        if (row.state === "creating") continue;
        const sentId = findSentProof(row);
        if (!sentId) continue;
        markSent(row, sentId);
        result.sent += 1;
        result.triggerMailSync = true;
      }
      recoverTerminalDrafts(accountId, result);
      return result;
    }

    // Recover creating rows via Message-ID SEARCH when not in full scan (race).
    const creating = liveRows.filter((r) => r.state === "creating");
    for (const row of creating) {
      if (matchLive(row, live)) continue;
      const found = await recoverCreatingAsync(creds, row);
      if (found) live.push(found);
    }

    const result = reconcileAgainstLiveMetas({
      accountId,
      live,
      rows: liveRows,
    });

    opts?.onProgress?.(
      "ok",
      t("sync.draftsSummary", {
        present: result.present,
        sent: result.sent,
        deleted: result.deleted,
        failed: result.failed,
      }),
    );
    return result;
  })();

  globalThis.__cmaeDraftsReconcile = runPromise;
  try {
    return await runPromise;
  } finally {
    if (globalThis.__cmaeDraftsReconcile === runPromise) {
      globalThis.__cmaeDraftsReconcile = null;
    }
  }
}

/** @deprecated Prefer enqueueDraftsReconcile / runDraftsReconcile. */
export async function reconcilePendingAgainstLiveDrafts(opts?: {
  force?: boolean;
}): Promise<{ checked: number; cleared: number; set: number }> {
  void opts;
  const r = await runDraftsReconcile();
  return {
    checked: r.checked,
    cleared: r.deleted + r.sent,
    set: r.present,
  };
}
