import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { getDb, getSqlite } from "@/lib/db/client";
import { bumpRevision } from "@/lib/db/revision";
import { mailMessages, mailSources, syncState } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { GmailImapSource, WINDOW_DAYS } from "@/lib/mail/gmail-imap-source";
import type { MailSource, SourceMail } from "@/lib/mail/source";
import {
  FETCH_ABANDON_AFTER,
  META_SCAN_INTERVAL_MS,
  normalizeAccountEmail,
} from "@/lib/mail/source";
import {
  clearFetchFailure,
  getFetchFailureAttempts,
  getMailSourceCursor,
  markMailSourceMetaScanned,
  recordFetchFailure,
  setMailSourceCursor,
} from "@/lib/mail/sources-store";
import { getGmailCredentials } from "@/lib/settings/service";
import { setFolderCursor } from "./folder-cursors";
import { SyncCanceledError, throwIfSyncCanceled } from "./cancel";
import { normalizeMailText } from "./signals";
import type { SyncProgressFn } from "./types";

export type SyncMode = "incremental" | "hard";

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
  insertedIds: number[];
  pendingTouched: boolean;
};

function findExistingMail(
  m: SourceMail,
  accountId: string,
): typeof mailMessages.$inferSelect | undefined {
  const db = getDb();
  if (m.gmMsgid) {
    const byGm = db
      .select()
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.accountId, accountId),
          eq(mailMessages.gmMsgid, m.gmMsgid),
        ),
      )
      .get();
    if (byGm) return byGm;
  }
  return db
    .select()
    .from(mailMessages)
    .where(eq(mailMessages.messageId, m.messageId))
    .get();
}

/**
 * Upsert by gm_msgid (preferred) or messageId — with account_id scope.
 * Label-only / content changes mark derive_state=pending.
 */
export function upsertSourceMails(
  mails: SourceMail[],
  accountId: string,
): UpsertMailsResult {
  const db = getDb();
  let upserted = 0;
  const insertedIds: number[] = [];
  let pendingTouched = false;

  for (const m of mails) {
    const existing = findExistingMail(m, accountId);
    const labelsJson = JSON.stringify(m.labels || []);
    const autoFlags = m.autoFlags ? JSON.stringify(m.autoFlags) : null;

    if (existing) {
      const labelsChanged = (existing.labelsJson || "[]") !== labelsJson;
      const incomingBody = normalizeMailText(m.bodyText || "");
      // Failed/empty body fetch must not wipe a previously good body.
      const keepExistingBody =
        !incomingBody &&
        Boolean(existing.bodyText) &&
        (m.bodyState === "failed" || !m.bodyText);
      const nextBodyText = keepExistingBody
        ? existing.bodyText
        : incomingBody || existing.bodyText || "";
      const nextBodyState = keepExistingBody
        ? existing.bodyState === "failed"
          ? "failed"
          : existing.bodyState || "ok"
        : m.bodyState || existing.bodyState || "ok";
      const bodyChanged =
        Boolean(incomingBody) &&
        incomingBody !== normalizeMailText(existing.bodyText || "");
      const contentChanged =
        bodyChanged ||
        normalizeMailText(m.subject || "") !==
          normalizeMailText(existing.subject || "") ||
        m.threadId !== existing.threadId;

      const shouldPending =
        contentChanged ||
        labelsChanged ||
        existing.deriveState === "pending" ||
        // Body refill after a failed fetch → re-derive with real text.
        (bodyChanged && existing.bodyState === "failed");

      if (shouldPending) pendingTouched = true;

      db.update(mailMessages)
        .set({
          accountId,
          messageId: m.messageId || existing.messageId,
          gmMsgid: m.gmMsgid ?? existing.gmMsgid,
          threadId: m.threadId ?? existing.threadId,
          gmailUid: m.gmailUid ?? existing.gmailUid,
          folder: m.folder,
          fromAddr: m.fromAddr,
          toAddr: m.toAddr,
          ccAddr: m.ccAddr,
          subject: normalizeMailText(m.subject || existing.subject),
          // Prefer internal_date; do not slide date on hard sync with missing header.
          dateIso: m.internalDate || m.dateIso || existing.dateIso,
          internalDate: m.internalDate ?? existing.internalDate,
          headerDate: m.headerDate ?? existing.headerDate,
          snippet: normalizeMailText(
            (incomingBody ? m.snippet : "") || existing.snippet,
          ).slice(0, 240),
          bodyText: nextBodyText,
          bodyState: nextBodyState,
          headersHash: m.headersHash ?? existing.headersHash,
          labelsJson,
          direction: m.direction || existing.direction,
          inReplyTo: m.inReplyTo ?? existing.inReplyTo,
          referencesHdr: m.referencesHdr ?? existing.referencesHdr,
          autoFlags: autoFlags ?? existing.autoFlags,
          // Returning from Gmail clears gone (K1 restore).
          goneAt: null,
          goneReason: null,
          deriveState: shouldPending ? "pending" : existing.deriveState,
        })
        .where(eq(mailMessages.id, existing.id))
        .run();
    } else {
      pendingTouched = true;
      const row = db
        .insert(mailMessages)
        .values({
          accountId,
          messageId: m.messageId,
          gmMsgid: m.gmMsgid,
          threadId: m.threadId,
          gmailUid: m.gmailUid,
          folder: m.folder,
          fromAddr: m.fromAddr,
          toAddr: m.toAddr,
          ccAddr: m.ccAddr,
          subject: normalizeMailText(m.subject),
          dateIso: m.internalDate || m.dateIso,
          internalDate: m.internalDate,
          headerDate: m.headerDate,
          snippet: normalizeMailText(m.snippet).slice(0, 240),
          bodyText: normalizeMailText(m.bodyText),
          bodyState: m.bodyState || "ok",
          headersHash: m.headersHash,
          labelsJson,
          direction: m.direction,
          inReplyTo: m.inReplyTo,
          referencesHdr: m.referencesHdr,
          autoFlags,
          deriveState: "pending",
        })
        .returning({ id: mailMessages.id })
        .get();
      if (row?.id) insertedIds.push(row.id);
    }
    upserted += 1;
  }
  return { upserted, insertedIds, pendingTouched };
}

/** @deprecated Prefer upsertSourceMails — kept for callers that still pass FetchedMail-shaped data. */
export function upsertMails(
  mails: Array<{
    messageId: string;
    threadId: string | null;
    gmailUid: number | null;
    folder: "INBOX" | "SENT";
    fromAddr: string;
    toAddr: string;
    ccAddr: string;
    subject: string;
    dateIso: string;
    snippet: string;
    bodyText: string;
    headersHash: string | null;
  }>,
): UpsertMailsResult {
  const accountId =
    normalizeAccountEmail(
      getGmailCredentials()?.address || "",
    ) || "";
  return upsertSourceMails(
    mails.map((m) => ({
      ...m,
      gmMsgid: null,
      sourceRole: m.folder === "SENT" ? "sent" : "inbox",
      headerDate: m.dateIso,
      internalDate: m.dateIso,
      bodyState: "ok" as const,
      labels: [],
      direction: "in" as const,
      inReplyTo: null,
      referencesHdr: null,
      autoFlags: null,
    })),
    accountId,
  );
}

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

export function markAllPendingDeriveDone(): void {
  const db = getDb();
  db.update(mailMessages)
    .set({ deriveState: "done" })
    .where(ne(mailMessages.deriveState, "done"))
    .run();
}

function applyLabelDeltas(
  accountId: string,
  deltas: Array<{
    gmMsgid: string | null;
    uid: number;
    labels: string[];
  }>,
): boolean {
  if (!deltas.length) return false;
  const db = getDb();
  let touched = false;
  for (const d of deltas) {
    let row =
      d.gmMsgid
        ? db
            .select()
            .from(mailMessages)
            .where(
              and(
                eq(mailMessages.accountId, accountId),
                eq(mailMessages.gmMsgid, d.gmMsgid),
              ),
            )
            .get()
        : undefined;
    if (!row && d.uid > 0) {
      row = db
        .select()
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.accountId, accountId),
            eq(mailMessages.gmailUid, d.uid),
          ),
        )
        .get();
    }
    if (!row) continue;
    const labelsJson = JSON.stringify(d.labels);
    if ((row.labelsJson || "[]") === labelsJson) continue;
    touched = true;
    db.update(mailMessages)
      .set({
        labelsJson,
        deriveState: "pending",
      })
      .where(eq(mailMessages.id, row.id))
      .run();
  }
  return touched;
}

function applyGoneMarks(
  accountId: string,
  gone: Array<{
    gmMsgid: string | null;
    uid: number | null;
    reason: string;
  }>,
  restored: Array<{ gmMsgid: string | null; uid: number | null }>,
): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  let touched = false;

  for (const g of gone) {
    let row =
      g.gmMsgid
        ? db
            .select()
            .from(mailMessages)
            .where(
              and(
                eq(mailMessages.accountId, accountId),
                eq(mailMessages.gmMsgid, g.gmMsgid),
              ),
            )
            .get()
        : undefined;
    if (!row && g.uid) {
      row = db
        .select()
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.accountId, accountId),
            eq(mailMessages.gmailUid, g.uid),
          ),
        )
        .get();
    }
    if (!row || row.goneAt) continue;
    touched = true;
    db.update(mailMessages)
      .set({
        goneAt: now,
        goneReason: g.reason || "expunged",
      })
      .where(eq(mailMessages.id, row.id))
      .run();
  }

  for (const r of restored) {
    let row =
      r.gmMsgid
        ? db
            .select()
            .from(mailMessages)
            .where(
              and(
                eq(mailMessages.accountId, accountId),
                eq(mailMessages.gmMsgid, r.gmMsgid),
              ),
            )
            .get()
        : undefined;
    if (!row && r.uid) {
      row = db
        .select()
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.accountId, accountId),
            eq(mailMessages.gmailUid, r.uid),
          ),
        )
        .get();
    }
    if (!row?.goneAt) continue;
    touched = true;
    db.update(mailMessages)
      .set({ goneAt: null, goneReason: null })
      .where(eq(mailMessages.id, row.id))
      .run();
  }

  return touched;
}

/** UIDs whose body_state is failed and not yet abandoned — re-fetch on next sync. */
function listBodyRetryUidsForRole(
  accountId: string,
  role: "all" | "inbox" | "sent" | "drafts",
): number[] {
  const db = getDb();
  const base = and(
    eq(mailMessages.accountId, accountId),
    eq(mailMessages.bodyState, "failed"),
    isNotNull(mailMessages.gmailUid),
  );
  const rows =
    role === "all"
      ? db.select({ uid: mailMessages.gmailUid }).from(mailMessages).where(base).all()
      : db
          .select({ uid: mailMessages.gmailUid })
          .from(mailMessages)
          .where(
            and(
              base,
              eq(
                mailMessages.folder,
                role === "sent" ? "SENT" : "INBOX",
              ),
            ),
          )
          .all();

  const out: number[] = [];
  for (const r of rows) {
    const uid = r.uid;
    if (typeof uid !== "number" || uid <= 0) continue;
    const attempts = getFetchFailureAttempts(accountId, role, uid);
    if (attempts >= FETCH_ABANDON_AFTER) continue;
    out.push(uid);
  }
  return out;
}

function listKnownUidsForRole(
  accountId: string,
  role: "all" | "inbox" | "sent" | "drafts",
  windowDays: number,
): Array<{ uid: number; gmMsgid: string | null }> {
  const db = getDb();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffIso = cutoff.toISOString();

  // For All Mail role, all account mails in window; else filter by folder.
  const rows =
    role === "all"
      ? db
          .select({
            uid: mailMessages.gmailUid,
            gmMsgid: mailMessages.gmMsgid,
          })
          .from(mailMessages)
          .where(
            and(
              eq(mailMessages.accountId, accountId),
              sql`${mailMessages.dateIso} >= ${cutoffIso}`,
              isNotNull(mailMessages.gmailUid),
            ),
          )
          .all()
      : db
          .select({
            uid: mailMessages.gmailUid,
            gmMsgid: mailMessages.gmMsgid,
          })
          .from(mailMessages)
          .where(
            and(
              eq(mailMessages.accountId, accountId),
              eq(
                mailMessages.folder,
                role === "sent" ? "SENT" : "INBOX",
              ),
              sql`${mailMessages.dateIso} >= ${cutoffIso}`,
              isNotNull(mailMessages.gmailUid),
            ),
          )
          .all();

  return rows
    .filter((r) => typeof r.uid === "number" && r.uid > 0)
    .map((r) => ({ uid: r.uid as number, gmMsgid: r.gmMsgid }));
}

function shouldMetaScan(
  accountId: string,
  roles: Array<"all" | "inbox" | "sent">,
  force: boolean,
): boolean {
  if (force) return true;
  const now = Date.now();
  const db = getDb();
  for (const role of roles) {
    const r = db
      .select()
      .from(mailSources)
      .where(
        and(eq(mailSources.accountId, accountId), eq(mailSources.role, role)),
      )
      .get();
    if (!r?.lastMetaScanAt) return true;
    const age = now - Date.parse(r.lastMetaScanAt);
    if (!Number.isFinite(age) || age >= META_SCAN_INTERVAL_MS) return true;
  }
  return false;
}

async function runWithMailSource(
  source: MailSource,
  opts: {
    mode: SyncMode;
    onProgress?: SyncProgressFn;
    signal?: AbortSignal;
    userEmail: string;
  },
): Promise<{
  upserted: number;
  insertedIds: number[];
  partial: boolean;
  partialError: string | null;
  usingAllMail: boolean;
}> {
  const log = opts.onProgress;
  const signal = opts.signal;
  const accountId = source.accountId;
  let upserted = 0;
  const insertedIds: number[] = [];

  await source.open();
  try {
    const discovery = await source.discover();
    if (!discovery.usingAllMail) {
      log?.("system", t("sync.allMailHiddenFallback"));
    }

    const summary = await source.sync({
      mode: opts.mode === "hard" ? "hard" : "incremental",
      windowDays: WINDOW_DAYS,
      userEmail: opts.userEmail,
      getCursor: (role) => getMailSourceCursor(accountId, role),
      getFailureAttempts: (role, uid) =>
        getFetchFailureAttempts(accountId, role, uid),
      listBodyRetryUids: (role) => listBodyRetryUidsForRole(accountId, role),
      onProgress: log,
      signal,
      onBatch: async (batch) => {
        throwIfSyncCanceled(signal);
        getSqlite().transaction(() => {
          let batchPending = false;
          if (batch.mails.length) {
            const result = upsertSourceMails(batch.mails, accountId);
            upserted += result.upserted;
            insertedIds.push(...result.insertedIds);
            batchPending = result.pendingTouched;
            for (const m of batch.mails) {
              if (!m.gmailUid) continue;
              if (m.bodyState === "failed") {
                // Meta-ok / body-failed: keep on the retry queue.
                recordFetchFailure({
                  accountId,
                  role: batch.role,
                  uid: m.gmailUid,
                  error:
                    batch.failures.find((f) => f.uid === m.gmailUid)?.error ||
                    "body fetch failed",
                });
              } else {
                clearFetchFailure(accountId, batch.role, m.gmailUid);
              }
            }
          }
          for (const f of batch.failures) {
            // Missing entirely from FETCH — poison / gap tracking.
            if (batch.mails.some((m) => m.gmailUid === f.uid)) continue;
            recordFetchFailure({
              accountId,
              role: batch.role,
              uid: f.uid,
              error: f.error,
            });
          }
          setMailSourceCursor({
            accountId,
            role: batch.role,
            mailboxPath: batch.mailboxPath,
            uidValidity: batch.uidValidity,
            lastUid: batch.commitLastUid,
            highestModseq: batch.highestModseq,
          });
          // Dual-write legacy folder cursors for older code paths.
          if (batch.role === "inbox" || batch.role === "all") {
            setFolderCursor({
              folder: "INBOX",
              mailboxPath: batch.mailboxPath,
              uidValidity: batch.uidValidity,
              lastUid: batch.commitLastUid,
            });
          }
          if (batch.role === "sent") {
            setFolderCursor({
              folder: "SENT",
              mailboxPath: batch.mailboxPath,
              uidValidity: batch.uidValidity,
              lastUid: batch.commitLastUid,
            });
          }
          if (batchPending) {
            bumpRevision(getSqlite(), "sync", "upsert", []);
          }
        })();
      },
    });

    const rolesForMeta = discovery.usingAllMail
      ? (["all"] as const)
      : (["inbox", "sent"] as const);
    const forceMeta =
      opts.mode === "hard" ||
      shouldMetaScan(accountId, [...rolesForMeta], false);

    if (forceMeta) {
      log?.("think", t("sync.metaScanStart"));
      const meta = await source.scanMeta({
        windowDays: WINDOW_DAYS,
        userEmail: opts.userEmail,
        force: true,
        getCursor: (role) => getMailSourceCursor(accountId, role),
        listKnownUids: (role) =>
          listKnownUidsForRole(accountId, role, WINDOW_DAYS),
        onProgress: log,
        signal,
      });

      getSqlite().transaction(() => {
        const labelsTouched = applyLabelDeltas(
          accountId,
          meta.labelDeltas.map((d) => ({
            gmMsgid: d.gmMsgid,
            uid: d.uid,
            labels: d.labels,
          })),
        );
        const goneTouched = applyGoneMarks(
          accountId,
          meta.gone,
          meta.restored,
        );
        const now = new Date().toISOString();
        for (const role of meta.scannedRoles) {
          markMailSourceMetaScanned(
            accountId,
            role,
            now,
            meta.highestModseqByRole[role] ?? null,
          );
        }
        if (labelsTouched || goneTouched) {
          bumpRevision(getSqlite(), "sync", "upsert", []);
        }
      })();
      log?.(
        "ok",
        t("sync.metaScanDone", {
          gone: meta.gone.length,
          labels: meta.labelDeltas.length,
        }),
      );
    }

    return {
      upserted,
      insertedIds,
      partial: summary.partial,
      partialError: summary.partialError,
      usingAllMail: summary.usingAllMail,
    };
  } finally {
    await source.close();
  }
}

export async function syncMailsFromGmail(opts?: {
  mode?: SyncMode;
  onProgress?: SyncProgressFn;
  signal?: AbortSignal;
  /** Inject MailSource (tests). Default: GmailImapSource. */
  source?: MailSource;
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
  if (!creds && !opts?.source) {
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
    const userEmail = creds?.address || opts?.source?.accountId || "";
    log?.(
      "curl",
      t("sync.connectingImap", { address: userEmail }),
    );

    const source =
      opts?.source ||
      new GmailImapSource(creds!.address, creds!.appPassword);

    // Always call getDb() fresh — never hold a drizzle handle across IMAP awaits.
    // Onboarding reconcile / path flip can closeDb() mid-sync; a stale wrapper
    // then throws better-sqlite3 "The database connection is not open".
    const beforeRows = getDb()
      .select({ id: mailMessages.id, dateIso: mailMessages.dateIso })
      .from(mailMessages)
      .all();
    const beforeCount = beforeRows.length;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - WINDOW_DAYS);
    const cutoffIso = cutoff.toISOString();

    const result = await runWithMailSource(source, {
      mode,
      onProgress: log,
      signal,
      userEmail,
    });

    throwIfSyncCanceled(signal);

    const afterRows = getDb()
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

    log?.(
      "ok",
      t("sync.upsertSummary", {
        upserted: result.upserted,
        total: afterCount,
        kept: keptOutsideWindow,
      }),
    );
    if (mode === "hard") {
      log?.("system", t("sync.hardSyncNote"));
    }
    if (result.partial && result.partialError) {
      log?.("err", result.partialError);
    }
    return {
      skipped: false,
      upserted: result.upserted,
      insertedIds: result.insertedIds,
      mode,
      keptOutsideWindow,
      partial: result.partial,
      partialError: result.partialError,
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

export { WINDOW_DAYS };
