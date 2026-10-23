import { createHash, randomUUID } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, getSqlite } from "@/lib/db/client";
import { bumpTrackerRevision } from "@/lib/db/revision";
import { gmailDrafts } from "@/lib/db/schema";
import { normalizeAccountId } from "@/lib/db/app-meta";
import { gmailDraftsFolderUrl } from "./imap";
import type { DraftKind } from "./types";

export type GmailDraftState =
  | "creating"
  | "present"
  | "sent"
  | "deleted_by_user"
  | "failed"
  | "unknown"
  | "superseded";

export const LIVE_DRAFT_STATES: GmailDraftState[] = [
  "creating",
  "present",
  "unknown",
];

export type GmailDraftRow = typeof gmailDrafts.$inferSelect;

export function makeDraftMessageId(id: string): string {
  return `<cmae-${id}@cmae.local>`;
}

export function contentHashForDraft(parts: {
  subject: string;
  to: string;
  body: string;
}): string {
  return createHash("sha256")
    .update(`${parts.subject}\n${parts.to}\n${parts.body}`)
    .digest("hex")
    .slice(0, 32);
}

/** Poll until a draft leaves `creating` (present / failed / deleted / …). */
export async function waitForDraftSettled(
  id: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<GmailDraftRow | null> {
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  const intervalMs = opts?.intervalMs ?? 400;
  const start = Date.now();
  for (;;) {
    const row =
      getDb().select().from(gmailDrafts).where(eq(gmailDrafts.id, id)).get() ??
      null;
    if (!row) return null;
    if (row.state !== "creating") return row;
    if (Date.now() - start >= timeoutMs) return row;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function getLiveDraftForItem(
  itemId: number,
  kind: DraftKind,
): GmailDraftRow | null {
  const db = getDb();
  return (
    db
      .select()
      .from(gmailDrafts)
      .where(
        and(
          eq(gmailDrafts.itemId, itemId),
          eq(gmailDrafts.kind, kind),
          inArray(gmailDrafts.state, LIVE_DRAFT_STATES),
        ),
      )
      .get() ?? null
  );
}

/** Live draft for list UX (any kind on the item). Prefer newest created. */
export function getLiveDraftAnyKind(itemId: number): GmailDraftRow | null {
  const rows = getDb()
    .select()
    .from(gmailDrafts)
    .where(
      and(
        eq(gmailDrafts.itemId, itemId),
        inArray(gmailDrafts.state, LIVE_DRAFT_STATES),
      ),
    )
    .all();
  if (!rows.length) return null;
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function listLiveDrafts(accountId?: string): GmailDraftRow[] {
  const db = getDb();
  const rows = db
    .select()
    .from(gmailDrafts)
    .where(inArray(gmailDrafts.state, LIVE_DRAFT_STATES))
    .all();
  if (!accountId) return rows;
  const acc = normalizeAccountId(accountId);
  return rows.filter((r) => r.accountId === acc);
}

export function countLiveDrafts(accountId?: string): number {
  return listLiveDrafts(accountId).length;
}

export function draftsUrlForAccount(address: string): string {
  return gmailDraftsFolderUrl(address);
}

/**
 * Insert creating row under unique live index.
 * On conflict returns the existing live row (exactly-once).
 */
export function insertCreatingDraft(opts: {
  itemId: number;
  accountId: string;
  kind: DraftKind;
  subject: string;
  toAddr: string;
  contentHash: string;
}): { row: GmailDraftRow; created: boolean } {
  const id = randomUUID();
  const messageIdHdr = makeDraftMessageId(id);
  const now = new Date().toISOString();
  const accountId = normalizeAccountId(opts.accountId);
  const sqlite = getSqlite();

  try {
    sqlite
      .prepare(
        `INSERT INTO gmail_drafts (
          id, item_id, account_id, kind, state, message_id_hdr,
          subject, to_addr, content_hash, created_at
        ) VALUES (?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.itemId,
        accountId,
        opts.kind,
        messageIdHdr,
        opts.subject,
        opts.toAddr,
        opts.contentHash,
        now,
      );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/unique|constraint/i.test(msg)) throw err;
    const existing = getLiveDraftForItem(opts.itemId, opts.kind);
    if (!existing) throw err;
    return { row: existing, created: false };
  }

  const row = getDb()
    .select()
    .from(gmailDrafts)
    .where(eq(gmailDrafts.id, id))
    .get();
  if (!row) throw new Error("gmail_drafts insert vanished");
  // No revision bump here — UI stays on "research done" until markDraftPresent
  // (item_ops lock already signals "saving" via SSE).
  return { row, created: true };
}

export function markDraftPresent(
  id: string,
  patch: {
    gmMsgid?: string | null;
    gmThrid?: string | null;
    draftsUid?: number | null;
    draftsUidvalidity?: string | null;
    subject?: string;
    toAddr?: string;
  },
): void {
  const now = new Date().toISOString();
  const sqlite = getSqlite();
  sqlite
    .prepare(
      `UPDATE gmail_drafts SET
         state = 'present',
         gm_msgid = COALESCE(?, gm_msgid),
         gm_thrid = COALESCE(?, gm_thrid),
         drafts_uid = COALESCE(?, drafts_uid),
         drafts_uidvalidity = COALESCE(?, drafts_uidvalidity),
         subject = COALESCE(?, subject),
         to_addr = COALESCE(?, to_addr),
         confirmed_at = COALESCE(confirmed_at, ?),
         last_seen_at = ?,
         last_checked_at = ?,
         missing_since = NULL,
         missing_checks = 0,
         error = NULL
       WHERE id = ?`,
    )
    .run(
      patch.gmMsgid ?? null,
      patch.gmThrid ?? null,
      patch.draftsUid ?? null,
      patch.draftsUidvalidity ?? null,
      patch.subject ?? null,
      patch.toAddr ?? null,
      now,
      now,
      now,
      id,
    );
  const row = getDb()
    .select()
    .from(gmailDrafts)
    .where(eq(gmailDrafts.id, id))
    .get();
  if (row) bumpTrackerRevision("drafts", "upsert", [row.itemId]);
}

export function markDraftFailed(id: string, error: string): void {
  const sqlite = getSqlite();
  sqlite
    .prepare(
      `UPDATE gmail_drafts SET state = 'failed', error = ?, last_checked_at = ?
       WHERE id = ? AND state = 'creating'`,
    )
    .run(error.slice(0, 500), new Date().toISOString(), id);
  const row = getDb()
    .select()
    .from(gmailDrafts)
    .where(eq(gmailDrafts.id, id))
    .get();
  if (row) bumpTrackerRevision("drafts", "upsert", [row.itemId]);
}

/** Gmail Drafts no longer has this message — clear live pending UX. */
export function markDraftDeletedByUser(id: string): void {
  const sqlite = getSqlite();
  sqlite
    .prepare(
      `UPDATE gmail_drafts SET
         state = 'deleted_by_user', last_checked_at = ?, error = NULL
       WHERE id = ? AND state IN ('creating', 'present', 'unknown')`,
    )
    .run(new Date().toISOString(), id);
  const row = getDb()
    .select()
    .from(gmailDrafts)
    .where(eq(gmailDrafts.id, id))
    .get();
  if (row) bumpTrackerRevision("drafts", "upsert", [row.itemId]);
}

/**
 * Local template was re-prepared — drop the live Gmail draft row so the next
 * "create Gmail draft" APPEND uses the new content (unique live index frees up).
 */
export function markLiveDraftSuperseded(
  itemId: number,
  kind: DraftKind,
): boolean {
  const live = getLiveDraftForItem(itemId, kind);
  if (!live) return false;
  const sqlite = getSqlite();
  sqlite
    .prepare(
      `UPDATE gmail_drafts SET
         state = 'superseded', last_checked_at = ?, error = NULL
       WHERE id = ? AND state IN ('creating', 'present', 'unknown')`,
    )
    .run(new Date().toISOString(), live.id);
  bumpTrackerRevision("drafts", "upsert", [itemId]);
  return true;
}

/** @deprecated No-op since Faz 8 (flags from workspace index + gmail_drafts). */
export function clearHasDraftFlagsForKind(
  _itemId: number,
  _kind: DraftKind,
): void {
  /* intentionally empty */
}

export function toPendingInfo(
  row: GmailDraftRow,
  address?: string | null,
): {
  kind: DraftKind;
  at: string;
  subject: string;
  draftsUrl?: string;
  state: GmailDraftState;
  confirmedAt: string | null;
} {
  return {
    kind: row.kind as DraftKind,
    at: row.createdAt,
    subject: row.subject,
    draftsUrl: address ? gmailDraftsFolderUrl(address) : undefined,
    state: row.state as GmailDraftState,
    confirmedAt: row.confirmedAt,
  };
}
