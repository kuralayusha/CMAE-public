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

function extractBody(source: Buffer | string | null | undefined): string {
  if (!source) return "";
  const raw = typeof source === "string" ? source : source.toString("utf8");
  const plain = raw.match(
    /Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\nContent-Type:|$)/i,
  );
  if (plain?.[1]) {
    return decodeQuotedPrintable(plain[1])
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 8000);
  }
  const html = raw.match(
    /Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\nContent-Type:|$)/i,
  );
  if (html?.[1]) {
    return stripHtml(decodeQuotedPrintable(html[1])).slice(0, 8000);
  }
  return stripHtml(decodeQuotedPrintable(raw)).slice(0, 8000);
}

function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
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
): Promise<T> {
  const client = new ImapFlow({
    host: GMAIL_HOST,
    port: GMAIL_PORT,
    secure: true,
    auth: { user: address, pass: appPassword },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

function mailFromMsg(
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
    source?: Buffer | false | null;
  },
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
  const bodyText = extractBody(msg.source || null);
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
    snippet: bodyText.slice(0, 240),
    bodyText,
    headersHash: headersHash(fromAddr, toAddr, subject, dateIso),
  };
}

async function fetchByRange(
  client: ImapFlow,
  folder: MailFolder,
  range: { since: Date } | { uid: string },
  onProgress?: SyncProgressFn,
  signal?: AbortSignal,
): Promise<FetchedMail[]> {
  const out: FetchedMail[] = [];
  const query =
    "since" in range
      ? { since: range.since }
      : range.uid;
  const options = "uid" in range ? { uid: true as const } : undefined;

  for await (const msg of client.fetch(
    query,
    {
      uid: true,
      envelope: true,
      source: true,
      threadId: true,
    },
    options,
  )) {
    throwIfSyncCanceled(signal);
    const mail = mailFromMsg(folder, msg);
    if (!mail) continue;
    out.push(mail);
    if (out.length % 25 === 0) {
      onProgress?.(
        "think",
        t("sync.messageCount", { folder, count: out.length }),
      );
    }
  }
  return out;
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

    const canIncremental =
      mode === "incremental" &&
      stored &&
      stored.uidValidity === uidValidity &&
      stored.mailboxPath === mailbox &&
      stored.lastUid > 0;

    if (canIncremental && stored) {
      const fromUid = stored.lastUid + 1;
      onProgress?.(
        "think",
        t("sync.incrementalUid", {
          folder,
          from: fromUid,
          cursor: stored.lastUid,
        }),
      );
      try {
        mails = await fetchByRange(
          client,
          folder,
          { uid: `${fromUid}:*` },
          onProgress,
          signal,
        );
        // Guard: some servers echo last UID on empty * range — keep only newer
        mails = mails.filter(
          (m) => typeof m.gmailUid === "number" && m.gmailUid > stored.lastUid,
        );
        strategy = "incremental";
      } catch (err) {
        throwIfSyncCanceled(signal);
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
      mails = await fetchByRange(
        client,
        folder,
        { since },
        onProgress,
        signal,
      );
      strategy = "window";
    }

    const cursor: FolderCursor = {
      folder,
      mailboxPath: mailbox,
      uidValidity: uidValidity || stored?.uidValidity || "0",
      lastUid: Math.max(
        highWaterUid(client),
        ...mails
          .map((m) => m.gmailUid || 0)
          .filter((n) => n > 0),
        stored?.lastUid ?? 0,
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
    lock.release();
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

export async function fetchRecentMail(
  address: string,
  appPassword: string,
  windowDays = WINDOW_DAYS,
  opts?: {
    mode?: ImapSyncMode;
    onProgress?: SyncProgressFn;
    signal?: AbortSignal;
  },
): Promise<{
  mails: FetchedMail[];
  mode: ImapSyncMode;
  strategies: Partial<Record<MailFolder, "incremental" | "window">>;
}> {
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

  return withClient(address, appPassword, async (client) => {
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
    const sentPath = await findSpecialMailbox(client, "\\Sent");
    let sentMails: FetchedMail[] = [];
    if (!sentPath) {
      log?.("err", t("sync.sentNotFound"));
      console.warn("[tracker/imap] Sent mailbox not found (SPECIAL-USE \\Sent)");
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

    return {
      mails: [...inbox.mails, ...sentMails],
      mode,
      strategies,
    };
  });
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

export async function appendDraft(
  address: string,
  appPassword: string,
  draft: DraftPayload,
): Promise<{ ok: true; draftsUrl: string }> {
  await withClient(address, appPassword, async (client) => {
    const draftsPath = await findSpecialMailbox(client, "\\Drafts");
    if (!draftsPath) {
      throw new Error("Gmail Drafts folder not found (SPECIAL-USE \\Drafts)");
    }
    const raw = buildRfc822(draft);
    await client.append(draftsPath, raw, ["\\Draft"]);
  });
  return {
    ok: true,
    draftsUrl: `https://mail.google.com/mail/?authuser=${encodeURIComponent(address)}#drafts`,
  };
}

export { WINDOW_DAYS };
