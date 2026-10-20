import { eq, inArray, ne } from "drizzle-orm";
import { getDb, getSqlite } from "@/lib/db/client";
import { mailMessages, syncState } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { getGmailCredentials } from "@/lib/settings/service";
import { setFolderCursor } from "./folder-cursors";
import { fetchRecentMail, WINDOW_DAYS, type ImapSyncMode } from "./imap";
import { SyncCanceledError, throwIfSyncCanceled } from "./cancel";
import { normalizeMailText } from "./signals";
import type { FetchedMail, SyncProgressFn } from "./types";

export type SyncMode = ImapSyncMode;

export type DeriveState = "pending" | "done";

export function isSyncDisabled(): boolean {
  return process.env.CMAE_DISABLE_SYNC === "1";
}

export function getSyncState() {
  const db = getDb();
  const row = db.select().from(syncState).where(eq(syncState.id, 1)).get();
  return {
    lastSyncAt: row?.lastSyncAt ?? null,
    lastError: row?.lastError ?? null,
    windowDays: row?.windowDays ?? WINDOW_DAYS,
  };
}

export function setSyncState(patch: {
  lastSyncAt?: string | null;
  lastError?: string | null;
}) {
  const db = getDb();
  const current = db.select().from(syncState).where(eq(syncState.id, 1)).get();
  db.update(syncState)
    .set({
      lastSyncAt:
        patch.lastSyncAt !== undefined ? patch.lastSyncAt : current?.lastSyncAt,
      lastError:
        patch.lastError !== undefined ? patch.lastError : current?.lastError,
      windowDays: WINDOW_DAYS,
    })
    .where(eq(syncState.id, 1))
    .run();
}

export type UpsertMailsResult = {
  upserted: number;
  /** DB ids of rows that did not exist before this upsert */
  insertedIds: number[];
};

/**
 * Upsert by messageId — duplicates yok.
 * Hard/incremental never deletes mail_messages (31+ day records are kept).
 * New rows are marked derive_state=pending until tracker derivation succeeds.
 */
export function upsertMails(mails: FetchedMail[]): UpsertMailsResult {
  const db = getDb();
  let upserted = 0;
  const insertedIds: number[] = [];
  for (const m of mails) {
    const existing = db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.messageId, m.messageId))
      .get();
    if (existing) {
      db.update(mailMessages)
        .set({
          threadId: m.threadId ?? existing.threadId,
          gmailUid: m.gmailUid ?? existing.gmailUid,
          folder: m.folder,
          fromAddr: m.fromAddr,
          toAddr: m.toAddr,
          ccAddr: m.ccAddr,
          subject: normalizeMailText(m.subject || existing.subject),
          dateIso: m.dateIso,
          snippet: normalizeMailText(m.snippet || existing.snippet).slice(0, 240),
          // Do not overwrite with an empty body (keep older/preserved body).
          // normalizeMailText also repairs UTF-8 mojibake from older QP decoders.
          bodyText: normalizeMailText(m.bodyText || existing.bodyText),
          headersHash: m.headersHash ?? existing.headersHash,
        })
        .where(eq(mailMessages.id, existing.id))
        .run();
    } else {
      const row = db
        .insert(mailMessages)
        .values({
          messageId: m.messageId,
          threadId: m.threadId,
          gmailUid: m.gmailUid,
          folder: m.folder,
          fromAddr: m.fromAddr,
          toAddr: m.toAddr,
          ccAddr: m.ccAddr,
          subject: normalizeMailText(m.subject),
          dateIso: m.dateIso,
          snippet: normalizeMailText(m.snippet).slice(0, 240),
          bodyText: normalizeMailText(m.bodyText),
          headersHash: m.headersHash,
          deriveState: "pending",
        })
        .returning({ id: mailMessages.id })
        .get();
      if (row?.id) insertedIds.push(row.id);
    }
    upserted += 1;
  }
  return { upserted, insertedIds };
}

/** Mail ids still waiting for tracker derivation after a failed patch/rebuild. */
export function listPendingDeriveMailIds(): number[] {
  const db = getDb();
  return db
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(eq(mailMessages.deriveState, "pending"))
    .all()
    .map((r) => r.id);
}

export function markMailsDeriveState(
  ids: number[],
  state: DeriveState,
): void {
  if (!ids.length) return;
  const db = getDb();
  db.update(mailMessages)
    .set({ deriveState: state })
    .where(inArray(mailMessages.id, ids))
    .run();
}

/** After a full rebuild, every pending mail has been considered. */
export function markAllPendingDeriveDone(): void {
  const db = getDb();
  db.update(mailMessages)
    .set({ deriveState: "done" })
    .where(ne(mailMessages.deriveState, "done"))
    .run();
}

export async function syncMailsFromGmail(opts?: {
  mode?: SyncMode;
  onProgress?: SyncProgressFn;
  signal?: AbortSignal;
}): Promise<{
  skipped: boolean;
  reason?: string;
  upserted: number;
  insertedIds: number[];
  mode: SyncMode;
  keptOutsideWindow: number;
  partial: boolean;
  partialError: string | null;
}> {
  const log = opts?.onProgress;
  const signal = opts?.signal;
  const mode: SyncMode = opts?.mode ?? "incremental";

  if (isSyncDisabled()) {
    setSyncState({ lastError: null });
    log?.("system", t("sync.imapDisabled"));
    return {
      skipped: true,
      reason: "CMAE_DISABLE_SYNC=1",
      upserted: 0,
      insertedIds: [],
      mode,
      keptOutsideWindow: 0,
      partial: false,
      partialError: null,
    };
  }

  const creds = getGmailCredentials();
  if (!creds) {
    const msg = t("sync.gmailMissing");
    setSyncState({ lastError: msg });
    log?.("err", msg);
    return {
      skipped: true,
      reason: msg,
      upserted: 0,
      insertedIds: [],
      mode,
      keptOutsideWindow: 0,
      partial: false,
      partialError: null,
    };
  }

  try {
    throwIfSyncCanceled(signal);
    log?.(
      "curl",
      t("sync.connectingImap", { address: creds.address }),
    );
    const fetched = await fetchRecentMail(
      creds.address,
      creds.appPassword,
      WINDOW_DAYS,
      { mode, onProgress: log, signal },
    );
    throwIfSyncCanceled(signal);

    const db = getDb();
    const beforeRows = db
      .select({ id: mailMessages.id, dateIso: mailMessages.dateIso })
      .from(mailMessages)
      .all();
    const beforeCount = beforeRows.length;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - WINDOW_DAYS);
    const cutoffIso = cutoff.toISOString();

    log?.(
      "think",
      t("sync.writingUpsert", { count: fetched.mails.length }),
    );

    let upserted = 0;
    let insertedIds: number[] = [];
    // Atomically commit mails + folder cursors (cursor must not advance without upsert).
    getSqlite().transaction(() => {
      const result = upsertMails(fetched.mails);
      upserted = result.upserted;
      insertedIds = result.insertedIds;
      for (const cursor of fetched.cursors) {
        setFolderCursor(cursor);
      }
    })();

    // Safety: row count must never drop after sync (no deletes)
    const afterRows = db
      .select({ id: mailMessages.id, dateIso: mailMessages.dateIso })
      .from(mailMessages)
      .all();
    const afterCount = afterRows.length;
    const keptOutsideWindow = afterRows.filter(
      (m) => m.dateIso < cutoffIso,
    ).length;

    if (afterCount < beforeCount) {
      throw new Error(
        t("sync.safetyMailDrop", {
          before: beforeCount,
          after: afterCount,
        }),
      );
    }

    // lastSyncAt is written by run.ts only after derivation finishes.
    log?.(
      "ok",
      t("sync.upsertSummary", {
        upserted,
        total: afterCount,
        kept: keptOutsideWindow,
      }),
    );
    if (mode === "hard") {
      log?.("system", t("sync.hardSyncNote"));
    }
    if (fetched.partial && fetched.partialError) {
      log?.("err", fetched.partialError);
    }
    return {
      skipped: false,
      upserted,
      insertedIds,
      mode,
      keptOutsideWindow,
      partial: fetched.partial,
      partialError: fetched.partialError,
    };
  } catch (err) {
    if (err instanceof SyncCanceledError) {
      log?.("err", t("sync.imapCanceled"));
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    setSyncState({ lastError: msg });
    log?.("err", t("sync.imapError", { msg }));
    throw err;
  }
}

export function listStoredMails() {
  const db = getDb();
  return db.select().from(mailMessages).all();
}
