/**
 * drafts_reconcile job — full Drafts mailbox scan + sent proof.
 * Never called from GET /api/tracker.
 */

import { eq } from "drizzle-orm";
import { getDb, getSqlite } from "@/lib/db/client";
import { bumpTrackerRevision } from "@/lib/db/revision";
import { gmailDrafts, mailMessages, trackerItems } from "@/lib/db/schema";
import { normalizeAccountId } from "@/lib/db/app-meta";
import {
  listAllDraftMetas,
  searchDraftByMessageId,
  type DraftMailboxMeta,
} from "@/lib/mail/gmail-imap-source";
import { getGmailCredentials } from "@/lib/settings/service";
import {
  LIVE_DRAFT_STATES,
  listLiveDrafts,
  markDraftPresent,
  type GmailDraftRow,
} from "./gmail-drafts-store";
import { reconcileDraftFlagsForRow } from "./pending-draft";

const MISSING_MIN_CHECKS = 2;
const MISSING_MIN_MS = 60_000;
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
      reject(new Error(`${label} timed out after ${ms}ms`));
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

function normMid(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase();
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

  const mid = row.messageIdHdr;
  if (mid && !mid.startsWith("legacy:")) {
    const byMid = sqlite
      .prepare(
        `SELECT id FROM mail_messages
         WHERE gone_at IS NULL
           AND message_id = ?
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
    const candidates = getDb()
      .select()
      .from(mailMessages)
      .all()
      .filter((m) => {
        if (m.goneAt) return false;
        if (m.folder !== "SENT" && m.direction !== "out") {
          const labels = (m.labelsJson || "").toLowerCase();
          if (!labels.includes("sent")) return false;
        }
        const when = m.internalDate || m.dateIso || m.createdAt;
        if (Date.parse(when) < createdMs) return false;
        if (!subjectsLooseMatch(sk, subjectKey(m.subject || ""))) return false;
        return (m.toAddr || "")
          .toLowerCase()
          .includes(row.toAddr.trim().toLowerCase());
      });
    if (candidates.length === 1) return candidates[0].id;
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
  bumpTrackerRevision("drafts", "upsert", [row.itemId]);
}

function markDeleted(row: GmailDraftRow): void {
  getSqlite()
    .prepare(
      `UPDATE gmail_drafts SET
         state = 'deleted_by_user', last_checked_at = ?, error = NULL
       WHERE id = ?`,
    )
    .run(new Date().toISOString(), row.id);
  // Re-enable prepare / create-draft from disk
  const item = getDb()
    .select()
    .from(trackerItems)
    .where(eq(trackerItems.id, row.itemId))
    .get();
  if (item) {
    reconcileDraftFlagsForRow(
      {
        ...item,
        hasFollowUpDraft: 0,
        hasThanksDraft: 0,
        hasReplyDraft: 0,
      },
      { persist: true },
    );
  }
  bumpTrackerRevision("drafts", "upsert", [row.itemId]);
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
        markFailed(row, "not found in Drafts after APPEND window");
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

    const { deleted } = bumpMissing(row, nowIso);
    if (deleted) result.deleted += 1;
  }

  void result.unknown;
  return result;
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
    if (!liveRows.length) {
      opts?.onProgress?.("ok", "No live Gmail drafts to reconcile");
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

    opts?.onProgress?.(
      "think",
      `Drafts reconcile: ${liveRows.length} live row(s)`,
    );

    let live: DraftMailboxMeta[] = [];
    try {
      if (opts?.signal?.aborted) throw new Error("aborted");
      live = await withTimeout(
        listAllDraftMetas(creds.address, creds.appPassword),
        RECONCILE_IMAP_TIMEOUT_MS,
        "Gmail Drafts full scan",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts?.onProgress?.("err", msg);
      for (const row of liveRows) {
        if (row.state === "present") {
          markUnknown(row, msg);
        }
      }
      return {
        checked: liveRows.length,
        present: 0,
        sent: 0,
        deleted: 0,
        failed: 0,
        unknown: liveRows.filter((r) => r.state === "present").length,
        triggerMailSync: false,
      };
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
      `Drafts: present=${result.present} sent=${result.sent} deleted=${result.deleted} failed=${result.failed}`,
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
