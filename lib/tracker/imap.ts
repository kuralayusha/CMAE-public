import { createHash } from "crypto";
import { ImapFlow } from "imapflow";
import { t } from "@/lib/i18n/t";
import { throwIfSyncCanceled } from "./cancel";
import {
  getFolderCursor,
  setFolderCursor,
  type FolderCursor,
} from "./folder-cursors";
import { decodeMimeBody, repairUtf8Mojibake } from "./mail-text";
import type { FetchedMail, MailFolder, SyncProgressFn } from "./types";

const GMAIL_HOST = "imap.gmail.com";
const GMAIL_PORT = 993;
const WINDOW_DAYS = 30;
const FETCH_META_MS = 20_000;
/** UIDs per fetchAll round-trip (same idea as the old streaming batch). */
const FETCH_BATCH_SIZE = 50;
const FETCH_BATCH_MS = 180_000;

class ImapConnectionDeadError extends Error {
  readonly partialMails: FetchedMail[];
  readonly deadAtUid: number;
  constructor(uid: number, cause: string, partialMails: FetchedMail[]) {
    super(`IMAP connection dead at uid ${uid}: ${cause}`);
    this.name = "ImapConnectionDeadError";
    this.deadAtUid = uid;
    this.partialMails = partialMails;
  }
}

export type ImapSyncMode = "incremental" | "hard";

function sinceDate(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addrList(
  value:
    | { address?: string | null; name?: string | null }[]
    | { address?: string | null; name?: string | null }
    | null
    | undefined,
): string {
  if (!value) return "";
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .map((a) => a.address || "")
    .filter(Boolean)
    .join(", ");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract readable body with charset-aware QP/base64 decode.
 * Prefer text/plain; fall back to stripped HTML.
 */
function extractBody(source: Buffer | string | null | undefined): string {
  if (!source) return "";
  // MIME wire format is ASCII-safe for headers + CTE; binary bytes kept via latin1.
  const raw =
    typeof source === "string" ? source : source.toString("binary");

  const part =
    matchMimePart(raw, "text/plain") || matchMimePart(raw, "text/html");
  if (part) {
    const decoded = repairUtf8Mojibake(
      decodeMimeBody(part.headers, part.body),
    );
    const text =
      part.kind === "html" ? stripHtml(decoded) : decoded.replace(/\s+/g, " ");
    return text.trim().slice(0, 8000);
  }

  // Single-part message: headers at top, body after blank line
  const split = raw.match(/^([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
  if (split) {
    const decoded = repairUtf8Mojibake(
      decodeMimeBody(split[1] || "", split[2] || ""),
    );
    return stripHtml(decoded).slice(0, 8000);
  }
  return stripHtml(repairUtf8Mojibake(raw)).slice(0, 8000);
}

function matchMimePart(
  raw: string,
  type: "text/plain" | "text/html",
): { headers: string; body: string; kind: "plain" | "html" } | null {
  const re = new RegExp(
    `(Content-Type:\\s*${type.replace("/", "\\/")}[^\\r\\n]*(?:\\r?\\n[^\\r\\n]+)*)\\r?\\n\\r?\\n([\\s\\S]*?)(?=\\r?\\n--[\\w=]|\\r?\\nContent-Type:|$)`,
    "i",
  );
  const m = raw.match(re);
  if (!m?.[1] || m[2] == null) return null;
  return {
    headers: m[1],
    body: m[2],
    kind: type === "text/html" ? "html" : "plain",
  };
}

function headersHash(from: string, to: string, subject: string, dateIso: string): string {
  return createHash("sha256")
    .update([from, to, subject, dateIso].join("|"))
    .digest("hex")
    .slice(0, 32);
}

function mailboxOrNull(client: ImapFlow) {
  const m = client.mailbox;
  if (m === false) return null;
  return m ?? null;
}

function uidValidityOf(client: ImapFlow): string {
  const v = mailboxOrNull(client)?.uidValidity;
  return v == null ? "" : String(v);
}

function highWaterUid(client: ImapFlow): number {
  const next = mailboxOrNull(client)?.uidNext;
  if (typeof next === "number" && next > 0) return next - 1;
  return 0;
}

async function withClient<T>(
  address: string,
  appPassword: string,
  fn: (client: ImapFlow) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const client = new ImapFlow({
    host: GMAIL_HOST,
    port: GMAIL_PORT,
    secure: true,
    auth: { user: address, pass: appPassword },
    logger: false,
    // Batch source FETCH can sit on large messages — do not kill mid-batch
    socketTimeout: 300_000,
    greetingTimeout: 15_000,
  });
  const onAbort = () => killClient(client);
  if (signal) {
    if (signal.aborted) {
      throwIfSyncCanceled(signal);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  await client.connect();
  try {
    return await fn(client);
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    try {
      await client.logout();
    } catch {
      killClient(client);
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`IMAP timeout after ${ms}ms (${label})`)),
        ms,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function mailFromEnvelope(
  folder: MailFolder,
  msg: {
    uid?: number;
    envelope?: {
      from?: Parameters<typeof addrList>[0];
      to?: Parameters<typeof addrList>[0];
      cc?: Parameters<typeof addrList>[0];
      subject?: string | null;
      date?: Date | string | null;
      messageId?: string | null;
    } | null;
    threadId?: string | number | null;
  },
  bodyText: string,
): FetchedMail | null {
  const env = msg.envelope;
  if (!env) return null;
  const fromAddr = addrList(env.from);
  const toAddr = addrList(env.to);
  const ccAddr = addrList(env.cc);
  const subject = env.subject || "";
  const date = env.date ? new Date(env.date) : new Date();
  const dateIso = date.toISOString();
  const messageId =
    (env.messageId || "").trim() ||
    `uid-${folder}-${msg.uid}-${headersHash(fromAddr, toAddr, subject, dateIso)}`;
  const body = bodyText.slice(0, 8000);
  return {
    messageId,
    threadId: msg.threadId ? String(msg.threadId) : null,
    gmailUid: typeof msg.uid === "number" ? msg.uid : null,
    folder,
    fromAddr,
    toAddr,
    ccAddr,
    subject,
    dateIso,
    snippet: body.slice(0, 240),
    bodyText: body,
    headersHash: headersHash(fromAddr, toAddr, subject, dateIso),
  };
}

function killClient(client: ImapFlow) {
  try {
    client.close();
  } catch {
    /* already closed */
  }
}

/**
 * True batch like the original sync: one IMAP FETCH for many UIDs with source.
 * Uses fetchAll (not download-in-loop) so imapflow does not deadlock.
 * SEARCH happens first — never FETCH { since } (that hangs on Gmail).
 */
async function fetchByUidList(
  client: ImapFlow,
  folder: MailFolder,
  uids: number[],
  onProgress?: SyncProgressFn,
  signal?: AbortSignal,
): Promise<FetchedMail[]> {
  const out: FetchedMail[] = [];
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const total = sorted.length;
  if (!total) return out;

  for (let i = 0; i < sorted.length; i += FETCH_BATCH_SIZE) {
    throwIfSyncCanceled(signal);
    const chunk = sorted.slice(i, i + FETCH_BATCH_SIZE);
    const doneAfter = Math.min(i + chunk.length, total);
    onProgress?.(
      "think",
      t("sync.fetchingBatch", {
        folder,
        current: doneAfter,
        total,
      }),
    );
    try {
      const messages = await withTimeout(
        client.fetchAll(
          chunk,
          {
            uid: true,
            envelope: true,
            source: true,
            threadId: true,
          },
          { uid: true },
        ),
        FETCH_BATCH_MS,
        `${folder} batch ${i + 1}-${doneAfter}/${total}`,
      );
      for (const msg of messages) {
        throwIfSyncCanceled(signal);
        const mail = mailFromEnvelope(
          folder,
          msg,
          extractBody(msg.source || null),
        );
        if (mail) out.push(mail);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onProgress?.("err", t("sync.fetchBatchFailed", { folder, msg }));
      killClient(client);
      throw new ImapConnectionDeadError(
        out.reduce((m, x) => Math.max(m, x.gmailUid || 0), 0) ||
          chunk[0] ||
          0,
        msg,
        out,
      );
    }
  }
  return out;
}

/**
 * Resolve → SEARCH UIDs → fetchAll batches with source (original batch shape).
 */
async function fetchByRange(
  client: ImapFlow,
  folder: MailFolder,
  range: { since: Date } | { uid: string },
  onProgress?: SyncProgressFn,
  signal?: AbortSignal,
): Promise<FetchedMail[]> {
  if (!("since" in range) && /^\d[\d,\s]*$/.test(range.uid.trim())) {
    const uids = range.uid
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (uids.length) {
      return fetchByUidList(client, folder, uids, onProgress, signal);
    }
  }

  throwIfSyncCanceled(signal);
  onProgress?.(
    "think",
    t("sync.messageCount", { folder, count: "…" }),
  );
  const found = await withTimeout(
    "since" in range
      ? client.search({ since: range.since }, { uid: true })
      : client.search({ uid: range.uid }, { uid: true }),
    FETCH_META_MS,
    `${folder} search`,
  );
  const uids = Array.isArray(found)
    ? found.filter((u): u is number => typeof u === "number" && u > 0)
    : [];
  if (!uids.length) return [];
  onProgress?.(
    "think",
    t("sync.messageCount", { folder, count: uids.length }),
  );
  return fetchByUidList(client, folder, uids, onProgress, signal);
}

/**
 * Incremental: UID > lastUid (body only for those).
 * Hard / fallback: SINCE windowDays (full bodies in window).
 * Never deletes DB rows — caller must only upsert.
 */
async function fetchFolder(
  client: ImapFlow,
  mailbox: string,
  folder: MailFolder,
  mode: ImapSyncMode,
  since: Date,
  onProgress?: SyncProgressFn,
  signal?: AbortSignal,
): Promise<{ mails: FetchedMail[]; strategy: "incremental" | "window" }> {
  throwIfSyncCanceled(signal);
  onProgress?.(
    "curl",
    t("sync.readingFolder", { folder, mailbox }),
  );
  const lock = await client.getMailboxLock(mailbox);
  try {
    const uidValidity = uidValidityOf(client);
    const stored = getFolderCursor(folder);
    let strategy: "incremental" | "window" = "window";
    let mails: FetchedMail[] = [];
    /** When a UID poisons the socket, advance cursor past it so the next sync continues. */
    let forceCursorUid = 0;
    let connectionDied = false;

    const canIncremental =
      mode === "incremental" &&
      stored &&
      stored.uidValidity === uidValidity &&
      stored.mailboxPath === mailbox &&
      stored.lastUid > 0;

    if (canIncremental && stored) {
      const fromUid = stored.lastUid + 1;
      const hw = highWaterUid(client);
      onProgress?.(
        "think",
        t("sync.incrementalUid", {
          folder,
          from: fromUid,
          cursor: stored.lastUid,
        }),
      );
      // Empty UID FETCH `n:*` (n past last message) can hang on Gmail/imapflow.
      // Skip when past high-water, or SEARCH returns nothing — never FETCH an empty *.
      if (hw > 0 && fromUid > hw) {
        onProgress?.(
          "ok",
          t("sync.incrementalEmpty", { folder, cursor: stored.lastUid }),
        );
        mails = [];
        strategy = "incremental";
      } else {
        try {
          throwIfSyncCanceled(signal);
          const found = await client.search(
            { uid: `${fromUid}:*` },
            { uid: true },
          );
          const uidList = Array.isArray(found)
            ? found.filter(
                (u): u is number =>
                  typeof u === "number" && u > stored.lastUid,
              )
            : [];
          if (!uidList.length) {
            onProgress?.(
              "ok",
              t("sync.incrementalEmpty", { folder, cursor: stored.lastUid }),
            );
            mails = [];
          } else {
            onProgress?.(
              "think",
              t("sync.messageCount", { folder, count: uidList.length }),
            );
            mails = await fetchByRange(
              client,
              folder,
              { uid: uidList.join(",") },
              onProgress,
              signal,
            );
            mails = mails.filter(
              (m) =>
                typeof m.gmailUid === "number" && m.gmailUid > stored.lastUid,
            );
          }
          strategy = "incremental";
        } catch (err) {
          throwIfSyncCanceled(signal);
          if (err instanceof ImapConnectionDeadError) {
            // Do NOT fall back to window FETCH on a dead socket — that hangs forever.
            connectionDied = true;
            mails = err.partialMails.filter(
              (m) =>
                typeof m.gmailUid === "number" && m.gmailUid > stored.lastUid,
            );
            forceCursorUid = err.deadAtUid;
            strategy = "incremental";
            onProgress?.(
              "err",
              t("sync.fetchConnectionDead", {
                folder,
                uid: err.deadAtUid,
              }),
            );
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            onProgress?.(
              "err",
              t("sync.incrementalFallback", { folder, msg }),
            );
            mails = await fetchByRange(
              client,
              folder,
              { since },
              onProgress,
              signal,
            );
            strategy = "window";
          }
        }
      }
    } else {
      if (mode === "incremental") {
        const why = !stored
          ? t("sync.whyNoCursor")
          : stored.uidValidity !== uidValidity
            ? t("sync.whyUidValidity")
            : stored.mailboxPath !== mailbox
              ? t("sync.whyMailboxChanged")
              : t("sync.whyCursorEmpty");
        onProgress?.(
          "think",
          t("sync.windowSync", { folder, why }),
        );
      } else {
        onProgress?.(
          "think",
          t("sync.hardSyncWindow", { folder }),
        );
      }
      try {
        mails = await fetchByRange(
          client,
          folder,
          { since },
          onProgress,
          signal,
        );
        strategy = "window";
      } catch (err) {
        throwIfSyncCanceled(signal);
        if (err instanceof ImapConnectionDeadError) {
          connectionDied = true;
          mails = err.partialMails;
          forceCursorUid = err.deadAtUid;
          strategy = "window";
          onProgress?.(
            "err",
            t("sync.fetchConnectionDead", {
              folder,
              uid: err.deadAtUid,
            }),
          );
        } else {
          throw err;
        }
      }
    }

    // Never jump lastUid to mailbox high-water after a partial/failed fetch —
    // that permanently skips unreadable UIDs. Only advance to what we saw or
    // explicitly abandoned (forceCursorUid after connection death).
    const mailUids = mails
      .map((m) => m.gmailUid || 0)
      .filter((n) => n > 0);
    const hw =
      connectionDied || !client.usable ? 0 : highWaterUid(client);
    const cursor: FolderCursor = {
      folder,
      mailboxPath: mailbox,
      uidValidity: uidValidity || stored?.uidValidity || "0",
      lastUid: Math.max(
        stored?.lastUid ?? 0,
        forceCursorUid,
        ...mailUids,
        // Clean empty incremental: park at high-water so we do not re-SEARCH
        strategy === "incremental" && mailUids.length === 0 && !forceCursorUid
          ? hw
          : 0,
      ),
    };
    setFolderCursor(cursor);

    onProgress?.(
      "ok",
      t("sync.cursorSummary", {
        folder,
        count: mails.length,
        strategy,
        uid: cursor.lastUid,
      }),
    );
    return { mails, strategy };
  } finally {
    try {
      lock.release();
    } catch {
      /* connection already closed */
    }
  }
}

type SpecialUse = "\\Sent" | "\\Drafts";

async function findSpecialMailbox(
  client: ImapFlow,
  specialUse: SpecialUse,
): Promise<string | null> {
  const list = await client.list();
  const want = specialUse.toLowerCase().replace(/^\\/, "");
  const hit = list.find((m) => {
    const su = (m.specialUse || "").toLowerCase().replace(/^\\/, "");
    return su === want;
  });
  return hit?.path ?? null;
}

export type FetchRecentMailResult = {
  mails: FetchedMail[];
  mode: ImapSyncMode;
  strategies: Partial<Record<MailFolder, "incremental" | "window">>;
};

/**
 * In-process IMAP fetch (SEARCH → fetchAll batches with source).
 */
export async function fetchRecentMailDirect(
  address: string,
  appPassword: string,
  windowDays = WINDOW_DAYS,
  opts?: {
    mode?: ImapSyncMode;
    onProgress?: SyncProgressFn;
    signal?: AbortSignal;
  },
): Promise<FetchRecentMailResult> {
  const mode: ImapSyncMode = opts?.mode ?? "incremental";
  const since = sinceDate(windowDays);
  const log = opts?.onProgress;
  const signal = opts?.signal;
  throwIfSyncCanceled(signal);
  log?.(
    "system",
    mode === "hard"
      ? t("sync.hardModeIntro", { days: windowDays })
      : t("sync.incrementalIntro", { days: windowDays }),
  );
  log?.(
    "system",
    t("sync.sinceNote", { date: since.toISOString().slice(0, 10) }),
  );

  return withClient(
    address,
    appPassword,
    async (client) => {
    throwIfSyncCanceled(signal);
    log?.("ok", t("sync.imapConnected"));
    const strategies: Partial<Record<MailFolder, "incremental" | "window">> =
      {};

    const inbox = await fetchFolder(
      client,
      "INBOX",
      "INBOX",
      mode,
      since,
      log,
      signal,
    );
    strategies.INBOX = inbox.strategy;

    throwIfSyncCanceled(signal);
    let sentMails: FetchedMail[] = [];
    if (!client.usable) {
      // INBOX fetch killed the socket — skip SENT this round (cursor already advanced)
      log?.("err", t("sync.sentSkippedDeadConnection"));
    } else {
      const sentPath = await findSpecialMailbox(client, "\\Sent");
      if (!sentPath) {
        log?.("err", t("sync.sentNotFound"));
        console.warn(
          "[tracker/imap] Sent mailbox not found (SPECIAL-USE \\Sent)",
        );
      } else {
        try {
          const sent = await fetchFolder(
            client,
            sentPath,
            "SENT",
            mode,
            since,
            log,
            signal,
          );
          sentMails = sent.mails;
          strategies.SENT = sent.strategy;
        } catch (err) {
          throwIfSyncCanceled(signal);
          const msg = err instanceof Error ? err.message : String(err);
          log?.("err", t("sync.sentReadFailed", { path: sentPath, msg }));
          console.warn(
            `[tracker/imap] Sent mailbox fetch failed (${sentPath}):`,
            err,
          );
        }
      }
    }

    return {
      mails: [...inbox.mails, ...sentMails],
      mode,
      strategies,
    };
  },
    signal,
  );
}

/**
 * Text-only IMAP fetch (no RFC822 source / attachments).
 * Runs in-process — a forked child breaks Vercel/Turbopack (`fork` is traced as a
 * module) and serverless has no durable tsx worker anyway. Hang risk is handled
 * by bodyStructure + maxBytes text parts + socket kill on timeout/cancel.
 */
export async function fetchRecentMail(
  address: string,
  appPassword: string,
  windowDays = WINDOW_DAYS,
  opts?: {
    mode?: ImapSyncMode;
    onProgress?: SyncProgressFn;
    signal?: AbortSignal;
  },
): Promise<FetchRecentMailResult> {
  return fetchRecentMailDirect(address, appPassword, windowDays, opts);
}

export type DraftAttachment = {
  filename: string;
  contentType?: string;
  buffer: Buffer;
};

export type DraftPayload = {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
  attachments?: DraftAttachment[];
};

function wrapBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

function encodeHeaderFilename(name: string): string {
  // Keep ASCII-safe for Content-Disposition; fall back to CV.pdf
  const safe = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return safe.trim() || "CV.pdf";
}

function buildRfc822(draft: DraftPayload): Buffer {
  const attachments = draft.attachments?.filter((a) => a.buffer?.length) || [];
  const common = [
    `From: ${draft.from}`,
    `To: ${draft.to}`,
    `Subject: ${draft.subject}`,
    "MIME-Version: 1.0",
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <cmae-draft-${Date.now()}@cmae.local>`,
  ];
  if (draft.inReplyTo) common.push(`In-Reply-To: ${draft.inReplyTo}`);
  if (draft.references) common.push(`References: ${draft.references}`);

  if (!attachments.length) {
    const headers = [
      ...common,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
    ];
    return Buffer.from(
      `${headers.join("\r\n")}\r\n\r\n${draft.body}\r\n`,
      "utf8",
    );
  }

  const boundary = `cmae_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const parts: Buffer[] = [];

  const preamble = [
    ...common,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `This is a multi-part message in MIME format.`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    draft.body,
    "",
  ].join("\r\n");
  parts.push(Buffer.from(preamble, "utf8"));

  for (const att of attachments) {
    const filename = encodeHeaderFilename(att.filename);
    const ctype = att.contentType || "application/pdf";
    const header = [
      `--${boundary}`,
      `Content-Type: ${ctype}; name="${filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${filename}"`,
      "",
      "",
    ].join("\r\n");
    parts.push(Buffer.from(header, "utf8"));
    parts.push(Buffer.from(wrapBase64(att.buffer.toString("base64")), "utf8"));
    parts.push(Buffer.from("\r\n", "utf8"));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return Buffer.concat(parts);
}

export function gmailDraftsFolderUrl(address: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(address)}#drafts`;
}

function subjectKey(subject: string): string {
  return subject
    .replace(/^(re|aw|wg|fwd|fw)\s*:\s*/gi, "")
    .trim()
    .toLowerCase();
}

function subjectsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Recent Drafts subjects (normalized keys) — one IMAP pass for reconcile.
 * Caps scan so list load stays snappy.
 */
export async function listRecentDraftSubjectKeys(
  address: string,
  appPassword: string,
  opts?: { sinceDays?: number; maxScan?: number },
): Promise<string[]> {
  const sinceDays = opts?.sinceDays ?? 30;
  const maxScan = opts?.maxScan ?? 120;
  return withClient(address, appPassword, async (client) => {
    const draftsPath = await findSpecialMailbox(client, "\\Drafts");
    if (!draftsPath) return [];
    const lock = await client.getMailboxLock(draftsPath);
    try {
      const since = new Date();
      since.setDate(since.getDate() - sinceDays);
      const keys: string[] = [];
      let checked = 0;
      for await (const msg of client.fetch(
        { since },
        { envelope: true, uid: true },
      )) {
        const sub = subjectKey(msg.envelope?.subject || "");
        if (sub) keys.push(sub);
        checked += 1;
        if (checked >= maxScan) break;
      }
      return keys;
    } finally {
      lock.release();
    }
  });
}

/** True if Drafts has at least one message whose subject matches (normalized). */
export async function draftExistsBySubject(
  address: string,
  appPassword: string,
  subject: string,
): Promise<boolean> {
  const needle = subjectKey(subject);
  if (!needle) return false;
  const keys = await listRecentDraftSubjectKeys(address, appPassword);
  return keys.some((k) => subjectsMatch(k, needle));
}

/** Poll Drafts until subject appears (IMAP lag after append). */
export async function waitForDraftSubject(
  address: string,
  appPassword: string,
  subject: string,
  opts?: { attempts?: number; delayMs?: number },
): Promise<boolean> {
  const attempts = opts?.attempts ?? 5;
  const delayMs = opts?.delayMs ?? 450;
  for (let i = 0; i < attempts; i++) {
    if (await draftExistsBySubject(address, appPassword, subject)) return true;
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

export function draftSubjectMatchesAny(
  subject: string,
  draftKeys: string[],
): boolean {
  const needle = subjectKey(subject);
  if (!needle) return false;
  return draftKeys.some((k) => subjectsMatch(k, needle));
}

export async function appendDraft(
  address: string,
  appPassword: string,
  draft: DraftPayload,
): Promise<{ ok: true; draftsUrl: string }> {
  await withClient(address, appPassword, async (client) => {
    const draftsPath = await findSpecialMailbox(client, "\\Drafts");
    if (!draftsPath) {
      throw new Error(t("tracker.error.gmailDraftsFolder"));
    }
    const raw = buildRfc822(draft);
    await client.append(draftsPath, raw, ["\\Draft"]);
  });
  return {
    ok: true,
    draftsUrl: gmailDraftsFolderUrl(address),
  };
}

export { WINDOW_DAYS };
