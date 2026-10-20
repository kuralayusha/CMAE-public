import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mailFetchFailures, mailSources } from "@/lib/db/schema";
import type { MailSourceCursor, MailSourceRole } from "./source";
import { FETCH_ABANDON_AFTER } from "./source";

export function getMailSourceCursor(
  accountId: string,
  role: MailSourceRole,
): MailSourceCursor | null {
  const db = getDb();
  const row = db
    .select()
    .from(mailSources)
    .where(
      and(eq(mailSources.accountId, accountId), eq(mailSources.role, role)),
    )
    .get();
  if (!row) return null;
  return {
    accountId: row.accountId,
    role: row.role as MailSourceRole,
    mailboxPath: row.mailboxPath,
    uidValidity: row.uidValidity,
    lastUid: row.lastUid,
    highestModseq: row.highestModseq,
  };
}

export function setMailSourceCursor(cursor: MailSourceCursor & {
  lastMetaScanAt?: string | null;
  lastSuccessAt?: string | null;
  lastErrorKind?: string | null;
}) {
  const db = getDb();
  const existing = getMailSourceCursor(cursor.accountId, cursor.role);
  if (existing) {
    db.update(mailSources)
      .set({
        mailboxPath: cursor.mailboxPath,
        uidValidity: cursor.uidValidity,
        lastUid: cursor.lastUid,
        highestModseq:
          cursor.highestModseq !== undefined
            ? cursor.highestModseq
            : existing.highestModseq,
        lastMetaScanAt:
          cursor.lastMetaScanAt !== undefined
            ? cursor.lastMetaScanAt
            : undefined,
        lastSuccessAt:
          cursor.lastSuccessAt !== undefined
            ? cursor.lastSuccessAt
            : undefined,
        lastErrorKind:
          cursor.lastErrorKind !== undefined
            ? cursor.lastErrorKind
            : undefined,
      })
      .where(
        and(
          eq(mailSources.accountId, cursor.accountId),
          eq(mailSources.role, cursor.role),
        ),
      )
      .run();
  } else {
    db.insert(mailSources)
      .values({
        accountId: cursor.accountId,
        role: cursor.role,
        mailboxPath: cursor.mailboxPath,
        uidValidity: cursor.uidValidity,
        lastUid: cursor.lastUid,
        highestModseq: cursor.highestModseq ?? null,
        lastMetaScanAt: cursor.lastMetaScanAt ?? null,
        lastSuccessAt: cursor.lastSuccessAt ?? null,
        lastErrorKind: cursor.lastErrorKind ?? null,
      })
      .run();
  }
}

export function markMailSourceMetaScanned(
  accountId: string,
  role: MailSourceRole,
  atIso: string,
  highestModseq?: string | null,
) {
  const cur = getMailSourceCursor(accountId, role);
  if (!cur) return;
  setMailSourceCursor({
    ...cur,
    lastMetaScanAt: atIso,
    highestModseq:
      highestModseq !== undefined ? highestModseq : cur.highestModseq,
  });
}

export function getFetchFailureAttempts(
  accountId: string,
  role: MailSourceRole,
  uid: number,
): number {
  const db = getDb();
  const row = db
    .select()
    .from(mailFetchFailures)
    .where(
      and(
        eq(mailFetchFailures.accountId, accountId),
        eq(mailFetchFailures.role, role),
        eq(mailFetchFailures.uid, uid),
      ),
    )
    .get();
  return row?.attempts ?? 0;
}

export function recordFetchFailure(opts: {
  accountId: string;
  role: MailSourceRole;
  uid: number;
  error: string;
}): { attempts: number; abandoned: boolean } {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .select()
    .from(mailFetchFailures)
    .where(
      and(
        eq(mailFetchFailures.accountId, opts.accountId),
        eq(mailFetchFailures.role, opts.role),
        eq(mailFetchFailures.uid, opts.uid),
      ),
    )
    .get();

  if (existing) {
    const attempts = existing.attempts + 1;
    const abandoned = attempts >= FETCH_ABANDON_AFTER ? 1 : existing.abandoned;
    db.update(mailFetchFailures)
      .set({
        attempts,
        lastError: opts.error,
        lastAt: now,
        abandoned,
      })
      .where(
        and(
          eq(mailFetchFailures.accountId, opts.accountId),
          eq(mailFetchFailures.role, opts.role),
          eq(mailFetchFailures.uid, opts.uid),
        ),
      )
      .run();
    return { attempts, abandoned: abandoned === 1 };
  }

  const attempts = 1;
  const abandoned = 0;
  db.insert(mailFetchFailures)
    .values({
      accountId: opts.accountId,
      role: opts.role,
      uid: opts.uid,
      attempts,
      lastError: opts.error,
      firstAt: now,
      lastAt: now,
      abandoned,
    })
    .run();
  return { attempts, abandoned: false };
}

export function clearFetchFailure(
  accountId: string,
  role: MailSourceRole,
  uid: number,
) {
  const db = getDb();
  db.delete(mailFetchFailures)
    .where(
      and(
        eq(mailFetchFailures.accountId, accountId),
        eq(mailFetchFailures.role, role),
        eq(mailFetchFailures.uid, uid),
      ),
    )
    .run();
}
