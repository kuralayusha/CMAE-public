import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mailMessages, syncState } from "@/lib/db/schema";
import { getGmailCredentials } from "@/lib/settings/service";
import { fetchRecentMail, WINDOW_DAYS, type ImapSyncMode } from "./imap";
import { SyncCanceledError, throwIfSyncCanceled } from "./cancel";
import type { FetchedMail, SyncProgressFn } from "./types";

export type SyncMode = ImapSyncMode;

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

function setSyncState(patch: {
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

/**
 * Upsert by messageId — duplicates yok.
 * Hard/incremental asla mail_messages silmez (31+ günlük kayıtlar kalır).
 */
export function upsertMails(mails: FetchedMail[]): number {
  const db = getDb();
  let upserted = 0;
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
          subject: m.subject,
          dateIso: m.dateIso,
          snippet: m.snippet || existing.snippet,
          // Boş body ile üzerine yazma (eski/korunan gövde kalsın)
          bodyText: m.bodyText || existing.bodyText,
          headersHash: m.headersHash ?? existing.headersHash,
        })
        .where(eq(mailMessages.id, existing.id))
        .run();
    } else {
      db.insert(mailMessages)
        .values({
          messageId: m.messageId,
          threadId: m.threadId,
          gmailUid: m.gmailUid,
          folder: m.folder,
          fromAddr: m.fromAddr,
          toAddr: m.toAddr,
          ccAddr: m.ccAddr,
          subject: m.subject,
          dateIso: m.dateIso,
          snippet: m.snippet,
          bodyText: m.bodyText,
          headersHash: m.headersHash,
        })
        .run();
    }
    upserted += 1;
  }
  return upserted;
}

export async function syncMailsFromGmail(opts?: {
  mode?: SyncMode;
  onProgress?: SyncProgressFn;
  signal?: AbortSignal;
}): Promise<{
  skipped: boolean;
  reason?: string;
  upserted: number;
  mode: SyncMode;
  keptOutsideWindow: number;
}> {
  const log = opts?.onProgress;
  const signal = opts?.signal;
  const mode: SyncMode = opts?.mode ?? "incremental";

  if (isSyncDisabled()) {
    setSyncState({ lastError: null });
    log?.("system", "IMAP kapalı (CMAE_DISABLE_SYNC=1)");
    return {
      skipped: true,
      reason: "CMAE_DISABLE_SYNC=1",
      upserted: 0,
      mode,
      keptOutsideWindow: 0,
    };
  }

  const creds = getGmailCredentials();
  if (!creds) {
    const msg = "Gmail adresi veya App Password eksik — Ayarlar’dan ekleyin";
    setSyncState({ lastError: msg });
    log?.("err", msg);
    return {
      skipped: true,
      reason: msg,
      upserted: 0,
      mode,
      keptOutsideWindow: 0,
    };
  }

  try {
    throwIfSyncCanceled(signal);
    log?.("curl", `Gmail IMAP bağlanıyor (${creds.address})…`);
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

    log?.("think", `${fetched.mails.length} mail veritabanına yazılıyor (upsert)…`);
    const upserted = upsertMails(fetched.mails);

    // Güvenlik: sync sonrası satır sayısı asla düşmemeli (silme yok)
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
        `Sync güvenlik hatası: mail sayısı düştü (${beforeCount} → ${afterCount})`,
      );
    }

    setSyncState({ lastSyncAt: new Date().toISOString(), lastError: null });
    log?.(
      "ok",
      `${upserted} upsert · DB ${afterCount} mail · pencere dışı korunan ${keptOutsideWindow}`,
    );
    if (mode === "hard") {
      log?.(
        "system",
        "Hard sync: 30g+ kayıtlar silinmedi; aynı messageId tekrar yazılmaz",
      );
    }
    return { skipped: false, upserted, mode, keptOutsideWindow };
  } catch (err) {
    if (err instanceof SyncCanceledError) {
      log?.("err", "IMAP iptal edildi");
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    setSyncState({ lastError: msg });
    log?.("err", `IMAP hata: ${msg}`);
    throw err;
  }
}

export function listStoredMails() {
  const db = getDb();
  return db.select().from(mailMessages).all();
}
