import type { MailFolder, SyncProgressFn } from "@/lib/tracker/types";

export type MailSourceRole = "all" | "inbox" | "sent" | "drafts";

export type MailDirection = "in" | "out" | "self";

export type MailBodyState = "ok" | "truncated" | "failed";

export type MailGoneReason = "trash" | "spam" | "expunged" | "unknown";

export type MailSourceCursor = {
  accountId: string;
  role: MailSourceRole;
  mailboxPath: string;
  uidValidity: string;
  lastUid: number;
  highestModseq?: string | null;
};

/** Normalized mail fact from a MailSource (IMAP or fake). */
export type SourceMail = {
  messageId: string;
  gmMsgid: string | null;
  threadId: string | null;
  gmailUid: number | null;
  /** Legacy folder for derivation: INBOX | SENT */
  folder: MailFolder;
  sourceRole: MailSourceRole;
  fromAddr: string;
  toAddr: string;
  ccAddr: string;
  subject: string;
  /** Canonical date (internalDate preferred) */
  dateIso: string;
  headerDate: string | null;
  internalDate: string | null;
  snippet: string;
  bodyText: string;
  bodyState: MailBodyState;
  headersHash: string | null;
  labels: string[];
  direction: MailDirection;
  inReplyTo: string | null;
  referencesHdr: string | null;
  autoFlags: {
    autoSubmitted?: string | null;
    bulk?: boolean;
    listId?: string | null;
    bounce?: boolean;
  } | null;
};

export type MailFetchFailure = {
  uid: number;
  error: string;
};

export type MailFetchBatch = {
  role: MailSourceRole;
  mailboxPath: string;
  uidValidity: string;
  mails: SourceMail[];
  /**
   * Contiguous last_uid to commit with this batch.
   * May be less than max(mail UIDs) when a UID in the middle failed.
   */
  commitLastUid: number;
  highestModseq?: string | null;
  failures: MailFetchFailure[];
  /** UIDs that hit attempt limit and may advance contiguous cursor past them. */
  abandonedUids: number[];
};

export type MailboxDiscovery = {
  all: string | null;
  inbox: string;
  sent: string | null;
  drafts: string | null;
  /** True when using \All; false when falling back to INBOX+Sent. */
  usingAllMail: boolean;
};

export type MailSyncSummary = {
  fetched: number;
  batches: number;
  usingAllMail: boolean;
  partial: boolean;
  partialError: string | null;
  capabilities: {
    condstore: boolean;
    qresync: boolean;
  };
  rolesSynced: MailSourceRole[];
};

export type LabelDelta = {
  role: MailSourceRole;
  uid: number;
  gmMsgid: string | null;
  labels: string[];
  highestModseq: string | null;
};

export type GoneMark = {
  role: MailSourceRole;
  /** Prefer gmMsgid; uid used when gmMsgid unknown (legacy rows). */
  gmMsgid: string | null;
  uid: number | null;
  reason: MailGoneReason;
};

export type MailSourceSyncOpts = {
  mode: "incremental" | "hard" | "window_rescan";
  windowDays: number;
  userEmail: string;
  getCursor: (role: MailSourceRole) => MailSourceCursor | null;
  /** Called per IMAP batch; must commit upsert + cursor atomically. */
  onBatch: (batch: MailFetchBatch) => void | Promise<void>;
  onProgress?: SyncProgressFn;
  signal?: AbortSignal;
  /** Prior failure attempts by uid (account+role scoped by caller). */
  getFailureAttempts?: (role: MailSourceRole, uid: number) => number;
  /**
   * UIDs with body_state=failed that should be re-fetched even when the
   * incremental cursor has already advanced past them.
   */
  listBodyRetryUids?: (role: MailSourceRole) => number[];
};

export type MailSourceMetaOpts = {
  windowDays: number;
  userEmail: string;
  getCursor: (role: MailSourceRole) => MailSourceCursor | null;
  /** UIDs (and optional gm_msgid) currently known for the role within the window. */
  listKnownUids: (
    role: MailSourceRole,
  ) => Array<{ uid: number; gmMsgid: string | null }>;
  onProgress?: SyncProgressFn;
  signal?: AbortSignal;
  force?: boolean;
};

export type MailSourceMetaResult = {
  labelDeltas: LabelDelta[];
  gone: GoneMark[];
  restored: Array<{ gmMsgid: string | null; uid: number | null; role: MailSourceRole }>;
  scannedRoles: MailSourceRole[];
  highestModseqByRole: Partial<Record<MailSourceRole, string | null>>;
};

/**
 * Abstract mailbox provider. Production: GmailImapSource. Tests: FakeMailSource.
 */
export interface MailSource {
  readonly accountId: string;
  open(): Promise<void>;
  close(): Promise<void>;
  discover(): Promise<MailboxDiscovery>;
  sync(opts: MailSourceSyncOpts): Promise<MailSyncSummary>;
  /**
   * CONDSTORE label delta (when available) + periodic UID set-diff → gone.
   * Safe to call after sync; no-ops when nothing due.
   */
  scanMeta(opts: MailSourceMetaOpts): Promise<MailSourceMetaResult>;
}

export const BODY_MAX_BYTES = 64 * 1024;
export const FETCH_ABANDON_AFTER = 3;
export const META_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function normalizeAccountEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function folderFromLabels(
  labels: string[],
  fallback: MailFolder = "INBOX",
): MailFolder {
  const lower = labels.map((l) => l.toLowerCase());
  if (
    lower.some(
      (l) =>
        l === "\\sent" ||
        l === "sent" ||
        l === "\\sent mail" ||
        l.includes("sent"),
    )
  ) {
    return "SENT";
  }
  return fallback;
}

export function classifyDirection(
  fromAddr: string,
  toAddr: string,
  userEmail: string,
): MailDirection {
  const user = normalizeAccountEmail(userEmail);
  const from = normalizeAccountEmail(fromAddr.split(",")[0] || fromAddr);
  const to = normalizeAccountEmail(toAddr);
  if (from === user) {
    if (to.includes(user)) return "self";
    return "out";
  }
  return "in";
}

/** Highest contiguous UID ≤ maxSeen with no gaps from prevLast+1, treating abandoned as skippable. */
export function contiguousLastUid(opts: {
  prevLastUid: number;
  /** Successfully fetched UIDs in this batch (sorted unique). */
  fetchedUids: number[];
  /** UIDs that failed this round (not abandoned yet). */
  failedUids: number[];
  /** UIDs abandoned (≥ FETCH_ABANDON_AFTER) — cursor may pass them. */
  abandonedUids: number[];
}): number {
  const fetched = new Set(opts.fetchedUids);
  const failed = new Set(opts.failedUids);
  const abandoned = new Set(opts.abandonedUids);
  const candidates = [
    ...opts.fetchedUids,
    ...opts.failedUids,
    ...opts.abandonedUids,
  ].filter((n) => n > opts.prevLastUid);
  if (!candidates.length) return opts.prevLastUid;

  const max = Math.max(...candidates);
  let cursor = opts.prevLastUid;
  for (let uid = opts.prevLastUid + 1; uid <= max; uid++) {
    if (fetched.has(uid) || abandoned.has(uid)) {
      cursor = uid;
      continue;
    }
    if (failed.has(uid)) break;
    // UID not in this batch and not failed — may not exist (expunged gap).
    // Contiguous rule: only advance through UIDs we explicitly saw or abandoned.
    // Unknown gaps stop advancement so we re-SEARCH from cursor+1.
    if (!fetched.has(uid) && !abandoned.has(uid)) {
      // If we have fetched higher UIDs, a missing mid-UID is a hole — stop before it
      // only when it was in the requested set as a failure; otherwise IMAP SEARCH
      // simply did not return it (never existed) and we can continue if we only
      // walk the sorted fetched+abandoned set.
      break;
    }
  }
  return cursor;
}

/**
 * Contiguous advance over the ordered union of fetched+abandoned only
 * (IMAP SEARCH returns existing UIDs; holes are non-existent).
 */
export function contiguousLastUidFromFetched(opts: {
  prevLastUid: number;
  fetchedUids: number[];
  failedUids: number[];
  abandonedUids: number[];
}): number {
  const fetched = [...new Set(opts.fetchedUids)].sort((a, b) => a - b);
  const failed = new Set(opts.failedUids);
  const abandoned = new Set(opts.abandonedUids);
  let cursor = opts.prevLastUid;

  const all = [
    ...fetched,
    ...[...abandoned].filter((u) => u > opts.prevLastUid),
  ].sort((a, b) => a - b);
  const unique = [...new Set(all)];

  for (const uid of unique) {
    if (uid <= cursor) continue;
    // Gap of missing UIDs between cursor+1 and uid-1 are non-existent (SEARCH).
    // Stop only if a failed UID sits strictly between cursor and this uid.
    let blocked = false;
    for (let u = cursor + 1; u < uid; u++) {
      if (failed.has(u)) {
        blocked = true;
        break;
      }
    }
    if (blocked) break;
    if (failed.has(uid)) break;
    cursor = uid;
  }
  return cursor;
}
