import { createHash } from "crypto";
import { ImapFlow } from "imapflow";
import { t } from "@/lib/i18n/t";
import { throwIfSyncCanceled } from "./cancel";
import {
  getFolderCursor,
  setFolderCursor,
  type FolderCursor,
} from "./folder-cursors";
import type { FetchedMail, MailFolder, SyncProgressFn } from "./types";

const GMAIL_HOST = "imap.gmail.com";
const GMAIL_PORT = 993;
const WINDOW_DAYS = 30;
/** Never pull full RFC822 — signature images / PDF attachments hang imapflow. */
const TEXT_PART_MAX_BYTES = 100_000;
const FETCH_META_MS = 12_000;
const FETCH_PART_MS = 15_000;
const FETCH_ENVELOPE_MS = 10_000;

type StructureNode = {
  type?: string;
  part?: string;
  disposition?: string;
  childNodes?: StructureNode[];
};

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

function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

function decodeBase64Body(input: string): string {
  const compact = input.replace(/\s+/g, "");
  if (!compact) return "";
  const padLen = (4 - (compact.length % 4)) % 4;
  try {
    return Buffer.from(compact + "=".repeat(padLen), "base64").toString("utf8");
  } catch {
    return input;
  }
}

/** Decode a MIME part body according to its Content-Transfer-Encoding. */
function decodeMimePartBody(headers: string, body: string): string {
  const cte = (
    headers.match(/Content-Transfer-Encoding:\s*([^\s;]+)/i)?.[1] || ""
  )
    .trim()
    .toLowerCase();
  if (cte === "base64") return decodeBase64Body(body);
  if (cte === "quoted-printable" || cte === "7bit" || cte === "8bit" || !cte) {
    return decodeQuotedPrintable(body);
  }
  // unknown — try QP then base64-looking fallback
  const qp = decodeQuotedPrintable(body);
  const compact = body.replace(/\s+/g, "");
  if (
    /^[A-Za-z0-9+/]+={0,2}$/.test(compact.slice(0, 80)) &&
    !/[äöüÄÖÜß\s]{8,}/.test(qp.slice(0, 80))
  ) {
    return decodeBase64Body(body);
  }
  return qp;
}

function extractMimePart(
  raw: string,
  contentType: "text/plain" | "text/html",
): string | null {
  // Capture headers of this part + body until next boundary / next Content-Type / end
  const re = new RegExp(
    `(Content-Type:\\s*${contentType.replace("/", "\\/")}[^\\n]*\\r?\\n(?:(?!\\r?\\n\\r?\\n)[^\\n]*\\r?\\n)*)\\r?\\n([\\s\\S]*?)(?=\\r?\\n--|\\r?\\nContent-Type:|$)`,
    "i",
  );
  const m = raw.match(re);
  if (!m?.[2]) return null;
  return decodeMimePartBody(m[1] || "", m[2]);
}

function extractBody(source: Buffer | string | null | undefined): string {
  if (!source) return "";
  const rawFull =
    typeof source === "string" ? source : source.toString("utf8");
  const raw = rawFull.length > TEXT_PART_MAX_BYTES
    ? rawFull.slice(0, TEXT_PART_MAX_BYTES)
    : rawFull;
  const plain = extractMimePart(raw, "text/plain");
  if (plain?.trim()) {
    return plain.replace(/\s+/g, " ").trim().slice(0, 8000);
  }
  const html = extractMimePart(raw, "text/html");
  if (html?.trim()) {
    return stripHtml(html).slice(0, 8000);
  }
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const topHeaders =
    headerEnd >= 0 ? raw.slice(0, headerEnd + 1) : raw.slice(0, 800);
  const topBody = headerEnd >= 0 ? raw.slice(headerEnd + 1) : raw;
  const decodeInput = topBody.slice(0, 80_000);
  const decoded = decodeMimePartBody(
    topHeaders,
    decodeInput || raw.slice(0, 80_000),
  );
  return stripHtml(decoded).slice(0, 8000);
}

/** Prefer text/plain, else text/html. Skip attachments + image parts (signature CIDs). */
function findTextPartIds(node: StructureNode | undefined): {
  plain?: string;
  html?: string;
} {
  const out: { plain?: string; html?: string } = {};
  const walk = (n: StructureNode | undefined, isRoot: boolean) => {
    if (!n) return;
    const disp = (n.disposition || "").toLowerCase();
    if (disp === "attachment") return;
    const typ = (n.type || "").toLowerCase();
    if (typ.startsWith("image/")) return;
    if (typ === "text/plain") {
      const id = n.part || (isRoot ? "1" : undefined);
      if (id && !out.plain) out.plain = id;
    } else if (typ === "text/html") {
      const id = n.part || (isRoot ? "1" : undefined);
      if (id && !out.html) out.html = id;
    }
    for (const child of n.childNodes || []) walk(child, false);
  };
  walk(node, true);
  return out;
}

async function downloadTextPart(
  client: ImapFlow,
  uid: number,
  part: string,
): Promise<string> {
  const result = await client.download(String(uid), part, {
    uid: true,
    maxBytes: TEXT_PART_MAX_BYTES,
  });
  if (!result || !("content" in result) || !result.content) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of result.content as AsyncIterable<Buffer | Uint8Array>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buf);
    total += buf.length;
    if (total >= TEXT_PART_MAX_BYTES) break;
  }
  return Buffer.concat(chunks).toString("utf8");
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
    // Stuck FETCH must die — Promise.race alone does not cancel imapflow
    socketTimeout: 30_000,
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

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Envelope + bodyStructure only — never RFC822 source.
 * Text via download(part, { maxBytes }) so signature images / PDFs stay on the wire.
 */
async function fetchOneUid(
  client: ImapFlow,
  folder: MailFolder,
  uid: number,
  withBody: boolean,
): Promise<FetchedMail | null> {
  const msg = await client.fetchOne(
    String(uid),
    {
      uid: true,
      envelope: true,
      threadId: true,
      ...(withBody ? { bodyStructure: true } : {}),
    },
    { uid: true },
  );
  if (!msg) return null;

  let bodyText = "";
  if (withBody) {
    const parts = findTextPartIds(
      msg.bodyStructure as StructureNode | undefined,
    );
    if (parts.plain) {
      const raw = await withTimeout(
        downloadTextPart(client, uid, parts.plain),
        FETCH_PART_MS,
        `${folder} uid=${uid} text/plain`,
      );
      bodyText = raw.replace(/\s+/g, " ").trim();
    }
    if (!bodyText && parts.html) {
      const raw = await withTimeout(
        downloadTextPart(client, uid, parts.html),
        FETCH_PART_MS,
        `${folder} uid=${uid} text/html`,
      );
      bodyText = stripHtml(raw);
    }
  }
  return mailFromEnvelope(folder, msg, bodyText);
}

/**
 * One UID at a time. Timeouts kill the socket (Promise.race cannot cancel imapflow).
 * Never fetch SOURCE — attachments (e.g. signature images) must not be downloaded.
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

  for (let i = 0; i < sorted.length; i++) {
    throwIfSyncCanceled(signal);
    const uid = sorted[i]!;
    onProgress?.(
      "think",
      t("sync.fetchingOne", {
        folder,
        current: i + 1,
        total,
        uid,
      }),
    );
    try {
      const mail = await withTimeout(
        fetchOneUid(client, folder, uid, true),
        FETCH_META_MS + FETCH_PART_MS * 2,
        `${folder} uid=${uid} text`,
      );
      if (mail) out.push(mail);
      else {
        const stub = await withTimeout(
          fetchOneUid(client, folder, uid, false),
          FETCH_ENVELOPE_MS,
          `${folder} uid=${uid} envelope`,
        );
        if (stub) out.push(stub);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onProgress?.(
        "err",
        t("sync.fetchOneFailed", { folder, uid, msg }),
      );
      killClient(client);
      throw new ImapConnectionDeadError(uid, msg, out);
    }
    await yieldEventLoop();
  }
  return out;
}

/** Resolve to UID list, then text-only one-by-one — no batch SOURCE fetch. */
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
 * In-process IMAP fetch (text parts only). Prefer fetchRecentMail() which runs
 * this in a child process so a stuck socket cannot freeze Next.js.
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
 * IMAP in a forked child — SIGKILL on cancel so Next.js event loop never freezes.
 * Child sets CMAE_IMAP_IN_CHILD=1 and calls fetchRecentMailDirect.
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
  if (process.env.CMAE_IMAP_IN_CHILD === "1") {
    return fetchRecentMailDirect(address, appPassword, windowDays, opts);
  }
  const { runImapFetchInChild } = await import("./imap-child");
  return runImapFetchInChild(address, appPassword, windowDays, opts);
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
