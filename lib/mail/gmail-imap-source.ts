import { ImapFlow } from "imapflow";
import { t } from "@/lib/i18n/t";
import { throwIfSyncCanceled } from "@/lib/tracker/cancel";
import type { MailFolder, SyncProgressFn } from "@/lib/tracker/types";
import {
  extractBodyFromRaw,
  findTextPartIds,
  headersHash,
  parseHeaderBlock,
  textFromBodyPart,
} from "./body-extract";
import { trackImapConnection } from "./imap-connections";
import {
  BODY_MAX_BYTES,
  FETCH_ABANDON_AFTER,
  classifyDirection,
  contiguousLastUidFromFetched,
  folderFromLabels,
  normalizeAccountEmail,
  type GoneMark,
  type LabelDelta,
  type MailFetchBatch,
  type MailSource,
  type MailSourceCursor,
  type MailSourceMetaOpts,
  type MailSourceMetaResult,
  type MailSourceRole,
  type MailSourceSyncOpts,
  type MailSyncSummary,
  type MailboxDiscovery,
  type SourceMail,
} from "./source";

const GMAIL_HOST = "imap.gmail.com";
const GMAIL_PORT = 993;
export const WINDOW_DAYS = 30;
const FETCH_META_MS = 20_000;
const FETCH_BATCH_SIZE = 50;
const FETCH_BATCH_MS = 180_000;

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

function highestModseqOf(client: ImapFlow): string | null {
  const v = mailboxOrNull(client)?.highestModseq;
  if (v == null) return null;
  return String(v);
}

function killClient(client: ImapFlow) {
  try {
    client.close();
  } catch {
    /* already closed */
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(t("sync.imapTimedOut", { ms, label }))),
        ms,
      );
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Prefer imapflow's responseText / executedCommand over bare "Command failed". */
function formatImapError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & {
    responseStatus?: string;
    responseText?: string;
    executedCommand?: string;
  };
  const bits: string[] = [e.message];
  if (e.responseStatus) bits.push(e.responseStatus);
  if (e.responseText) bits.push(e.responseText);
  if (e.executedCommand) {
    const cmd =
      e.executedCommand.length > 180
        ? `${e.executedCommand.slice(0, 180)}…`
        : e.executedCommand;
    bits.push(cmd);
  }
  return bits.join(" — ");
}

/** One preferred MIME part (or TEXT) — never union parts across heterogeneous UIDs. */
function preferredBodyPartKeys(plan: {
  plain: string | null;
  html: string | null;
}): string[] {
  if (plan.plain) return [plan.plain];
  if (plan.html) return [plan.html];
  return ["TEXT"];
}

function bodyPartsQueryForKeys(keys: string[]) {
  return keys.map((key) => ({
    key,
    start: 0,
    maxLength: BODY_MAX_BYTES,
  }));
}

function labelsToArray(labels: Set<string> | string[] | null | undefined): string[] {
  if (!labels) return [];
  if (Array.isArray(labels)) return labels.map(String);
  return [...labels].map(String);
}

function toIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  try {
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toISOString();
  } catch {
    return null;
  }
}

type SpecialUse = "\\All" | "\\Sent" | "\\Drafts" | "\\Inbox";

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
  if (hit?.path) return hit.path;
  // Gmail sometimes exposes "[Gmail]/All Mail" without specialUse in list.
  if (specialUse === "\\All") {
    const byName = list.find((m) =>
      /all\s*mail/i.test(m.path) || /all\s*mail/i.test(m.name || ""),
    );
    return byName?.path ?? null;
  }
  return null;
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
    socketTimeout: 300_000,
    greetingTimeout: 15_000,
  });
  const onAbort = () => killClient(client);
  if (signal) {
    if (signal.aborted) throwIfSyncCanceled(signal);
    signal.addEventListener("abort", onAbort, { once: true });
  }
  await client.connect();
  trackImapConnection(1);
  try {
    return await fn(client);
  } finally {
    trackImapConnection(-1);
    if (signal) signal.removeEventListener("abort", onAbort);
    try {
      await client.logout();
    } catch {
      killClient(client);
    }
  }
}

function clientCapabilities(client: ImapFlow): {
  condstore: boolean;
  qresync: boolean;
} {
  const caps = client.capabilities;
  const has = (name: string) =>
    Boolean(caps?.has(name) || caps?.has(name.toUpperCase()));
  return {
    condstore: has("CONDSTORE"),
    qresync: has("QRESYNC"),
  };
}

type MetaMsg = {
  uid: number;
  emailId?: string;
  threadId?: string | number;
  labels?: Set<string>;
  envelope?: {
    from?: Parameters<typeof addrList>[0];
    to?: Parameters<typeof addrList>[0];
    cc?: Parameters<typeof addrList>[0];
    subject?: string | null;
    date?: Date | string | null;
    messageId?: string | null;
    inReplyTo?: string | null;
  } | null;
  internalDate?: Date | string | null;
  bodyStructure?: Parameters<typeof findTextPartIds>[0];
  headers?: Buffer;
  modseq?: bigint;
};

function buildSourceMail(opts: {
  role: MailSourceRole;
  folder: MailFolder;
  msg: MetaMsg;
  bodyText: string;
  bodyState: SourceMail["bodyState"];
  userEmail: string;
}): SourceMail | null {
  const env = opts.msg.envelope;
  if (!env) return null;
  const fromAddr = addrList(env.from);
  const toAddr = addrList(env.to);
  const ccAddr = addrList(env.cc);
  const subject = env.subject || "";
  const labels = labelsToArray(opts.msg.labels);
  const folder =
    opts.role === "all" ? folderFromLabels(labels, opts.folder) : opts.folder;

  const internalDate = toIso(opts.msg.internalDate);
  const headerDate = toIso(env.date);
  // Prefer server internal date; never invent "now" for missing Date header.
  const dateIso =
    internalDate ||
    headerDate ||
    `uid-${folder}-${opts.msg.uid}@undated.local`;

  const hdrs = parseHeaderBlock(opts.msg.headers);
  const inReplyTo =
    (env.inReplyTo || "").trim() || hdrs["in-reply-to"] || null;
  const referencesHdr = hdrs.references || null;
  const autoSubmitted = hdrs["auto-submitted"] || null;
  const precedence = (hdrs.precedence || "").toLowerCase();
  const listId = hdrs["list-id"] || null;
  const contentType = (hdrs["content-type"] || "").toLowerCase();
  const bounce =
    contentType.includes("delivery-status") ||
    contentType.includes("report-type=delivery-status");

  const messageId =
    (env.messageId || "").trim() ||
    (opts.msg.emailId
      ? `gm-${opts.msg.emailId}`
      : `uid-${folder}-${opts.msg.uid}-${headersHash(fromAddr, toAddr, subject, dateIso)}`);

  const body = opts.bodyText.slice(0, 8000);
  return {
    messageId,
    gmMsgid: opts.msg.emailId ? String(opts.msg.emailId) : null,
    threadId: opts.msg.threadId != null ? String(opts.msg.threadId) : null,
    gmailUid: opts.msg.uid,
    folder,
    sourceRole: opts.role,
    fromAddr,
    toAddr,
    ccAddr,
    subject,
    dateIso,
    headerDate,
    internalDate,
    snippet: body.slice(0, 240),
    bodyText: body,
    bodyState: opts.bodyState,
    headersHash: headersHash(fromAddr, toAddr, subject, dateIso),
    labels,
    direction: classifyDirection(fromAddr, toAddr, opts.userEmail),
    inReplyTo,
    referencesHdr,
    autoFlags: {
      autoSubmitted,
      bulk: precedence === "bulk" || precedence === "list",
      listId,
      bounce,
    },
  };
}

async function fetchUidBatch(
  client: ImapFlow,
  role: MailSourceRole,
  folder: MailFolder,
  uids: number[],
  userEmail: string,
  onProgress?: SyncProgressFn,
  signal?: AbortSignal,
  /** When the caller already chunks UIDs, pass mailbox-wide progress here. */
  progress?: { doneBefore: number; total: number },
): Promise<{ mails: SourceMail[]; failures: { uid: number; error: string }[] }> {
  const out: SourceMail[] = [];
  const failures: { uid: number; error: string }[] = [];
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  if (!sorted.length) return { mails: out, failures };

  for (let i = 0; i < sorted.length; i += FETCH_BATCH_SIZE) {
    throwIfSyncCanceled(signal);
    const chunk = sorted.slice(i, i + FETCH_BATCH_SIZE);
    const doneAfter = progress
      ? Math.min(progress.doneBefore + i + chunk.length, progress.total)
      : Math.min(i + chunk.length, sorted.length);
    const total = progress?.total ?? sorted.length;
    onProgress?.(
      "think",
      t("sync.fetchingBatch", {
        folder: role.toUpperCase(),
        current: doneAfter,
        total,
      }),
    );

    let meta: MetaMsg[] = [];
    try {
      const messages = await withTimeout(
        client.fetchAll(
          chunk,
          {
            uid: true,
            envelope: true,
            internalDate: true,
            emailId: true,
            threadId: true,
            labels: true,
            bodyStructure: true,
            headers: [
              "in-reply-to",
              "references",
              "auto-submitted",
              "precedence",
              "list-id",
              "content-type",
            ],
          },
          { uid: true },
        ),
        FETCH_BATCH_MS,
        `${role} meta ${i + 1}-${doneAfter}`,
      );
      meta = [...messages] as MetaMsg[];
    } catch (err) {
      // Soft-fail the chunk: earlier batches were already committed. Killing the
      // whole job after meta scan left the mailbox half-imported (and used to
      // killClient, which also aborted later body retries on a live socket).
      const msg = formatImapError(err);
      onProgress?.("err", t("sync.fetchBatchFailed", { folder: role, msg }));
      for (const uid of chunk) failures.push({ uid, error: msg });
      if (!client.usable) {
        for (const uid of sorted.slice(i + chunk.length)) {
          failures.push({ uid, error: msg });
        }
        return { mails: out, failures };
      }
      continue;
    }

    // Resolve per-message text part ids, then bodyParts fetch (no source:true).
    // Critical: do NOT union MIME part keys across the batch + always-TEXT.
    // Gmail rejects FETCH when the set asks for sections that some UIDs lack
    // → bare "Command failed" (NO/BAD). Group by identical preferred key instead.
    const partPlan = new Map<
      number,
      { plain: string | null; html: string | null }
    >();
    const groups = new Map<string, number[]>();
    for (const m of meta) {
      const parts = findTextPartIds(m.bodyStructure);
      partPlan.set(m.uid, parts);
      const keys = preferredBodyPartKeys(parts);
      const sig = keys.join("\0");
      const list = groups.get(sig);
      if (list) list.push(m.uid);
      else groups.set(sig, [m.uid]);
    }

    const bodies = new Map<number, Map<string, Buffer>>();
    for (const [sig, groupUids] of groups) {
      throwIfSyncCanceled(signal);
      const keys = sig.split("\0").filter(Boolean);
      const query = bodyPartsQueryForKeys(keys);
      const fetchBodies = async (uids: number[]) => {
        const bodyMsgs = await withTimeout(
          client.fetchAll(
            uids,
            { uid: true, bodyParts: query },
            { uid: true },
          ),
          FETCH_BATCH_MS,
          `${role} body ${uids[0]}…${uids[uids.length - 1]}`,
        );
        for (const bm of bodyMsgs) {
          if (typeof bm.uid === "number" && bm.bodyParts) {
            bodies.set(bm.uid, bm.bodyParts);
          }
        }
      };

      try {
        await fetchBodies(groupUids);
      } catch (err) {
        const msg = formatImapError(err);
        onProgress?.(
          "err",
          t("sync.fetchBatchFailed", { folder: role, msg }),
        );
        // Retry per-UID so one poison section does not wipe the whole group.
        for (const uid of groupUids) {
          throwIfSyncCanceled(signal);
          if (!client.usable) {
            failures.push({ uid, error: msg });
            continue;
          }
          try {
            await fetchBodies([uid]);
          } catch (uidErr) {
            const uidMsg = formatImapError(uidErr);
            failures.push({ uid, error: uidMsg });
            onProgress?.(
              "err",
              t("sync.fetchBatchFailed", {
                folder: role,
                msg: `uid ${uid}: ${uidMsg}`,
              }),
            );
          }
        }
      }
    }

    const got = new Set<number>();
    for (const m of meta) {
      throwIfSyncCanceled(signal);
      got.add(m.uid);
      const plan = partPlan.get(m.uid) || { plain: null, html: null };
      const parts = bodies.get(m.uid);
      let bodyText = "";
      let bodyState: SourceMail["bodyState"] = "ok";
      if (parts?.size) {
        if (plan.plain && parts.has(plan.plain)) {
          const buf = parts.get(plan.plain);
          bodyText = textFromBodyPart(buf, "plain");
          if (buf && buf.length >= BODY_MAX_BYTES) bodyState = "truncated";
        } else if (plan.html && parts.has(plan.html)) {
          const buf = parts.get(plan.html);
          bodyText = textFromBodyPart(buf, "html");
          if (buf && buf.length >= BODY_MAX_BYTES) bodyState = "truncated";
        } else if (parts.has("TEXT")) {
          const buf = parts.get("TEXT");
          bodyText = extractBodyFromRaw(buf || null);
          if (buf && buf.length >= BODY_MAX_BYTES) bodyState = "truncated";
        } else {
          // FETCH returned a bodyParts map without our preferred keys.
          bodyState = "failed";
          if (!failures.some((f) => f.uid === m.uid)) {
            failures.push({
              uid: m.uid,
              error: "body part keys missing from FETCH",
            });
          }
        }
      } else {
        // Missing body (fetch failure or empty response) — mark failed so
        // the next sync can retry via listBodyRetryUids.
        bodyState = "failed";
        if (!failures.some((f) => f.uid === m.uid)) {
          failures.push({
            uid: m.uid,
            error: "body FETCH returned no parts",
          });
        }
      }

      const mail = buildSourceMail({
        role,
        folder,
        msg: m,
        bodyText,
        bodyState,
        userEmail,
      });
      if (mail) out.push(mail);
    }

    for (const uid of chunk) {
      if (!got.has(uid)) {
        failures.push({ uid, error: "missing from FETCH response" });
      }
    }
  }

  return { mails: out, failures };
}

async function searchUids(
  client: ImapFlow,
  query: { since: Date } | { uid: string },
  signal?: AbortSignal,
): Promise<number[]> {
  throwIfSyncCanceled(signal);
  const found = await withTimeout(
    "since" in query
      ? client.search({ since: query.since }, { uid: true })
      : client.search({ uid: query.uid }, { uid: true }),
    FETCH_META_MS,
    "search",
  );
  return Array.isArray(found)
    ? found.filter((u): u is number => typeof u === "number" && u > 0)
    : [];
}

export class GmailImapSource implements MailSource {
  readonly accountId: string;
  private readonly address: string;
  private readonly appPassword: string;
  private client: ImapFlow | null = null;
  private discovery: MailboxDiscovery | null = null;
  private caps = { condstore: false, qresync: false };

  constructor(address: string, appPassword: string) {
    this.address = address;
    this.appPassword = appPassword;
    this.accountId = normalizeAccountEmail(address);
  }

  async open(): Promise<void> {
    if (this.client) return;
    const client = new ImapFlow({
      host: GMAIL_HOST,
      port: GMAIL_PORT,
      secure: true,
      auth: { user: this.address, pass: this.appPassword },
      logger: false,
      socketTimeout: 300_000,
      greetingTimeout: 15_000,
    });
    await client.connect();
    trackImapConnection(1);
    this.client = client;
    this.caps = clientCapabilities(client);
    this.discovery = await this.discover();
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    trackImapConnection(-1);
    try {
      await client.logout();
    } catch {
      killClient(client);
    }
  }

  async discover(): Promise<MailboxDiscovery> {
    const client = this.requireClient();
    const all = await findSpecialMailbox(client, "\\All");
    const sent = await findSpecialMailbox(client, "\\Sent");
    const drafts = await findSpecialMailbox(client, "\\Drafts");
    const discovery: MailboxDiscovery = {
      all,
      inbox: "INBOX",
      sent,
      drafts,
      usingAllMail: Boolean(all),
    };
    this.discovery = discovery;
    return discovery;
  }

  private requireClient(): ImapFlow {
    if (!this.client || !this.client.usable) {
      throw new Error("GmailImapSource not connected");
    }
    return this.client;
  }

  private rolesToSync(): Array<{
    role: MailSourceRole;
    path: string;
    folder: MailFolder;
  }> {
    const d = this.discovery;
    if (!d) return [{ role: "inbox", path: "INBOX", folder: "INBOX" }];
    if (d.usingAllMail && d.all) {
      return [{ role: "all", path: d.all, folder: "INBOX" }];
    }
    const roles: Array<{
      role: MailSourceRole;
      path: string;
      folder: MailFolder;
    }> = [{ role: "inbox", path: d.inbox, folder: "INBOX" }];
    if (d.sent) roles.push({ role: "sent", path: d.sent, folder: "SENT" });
    return roles;
  }

  async sync(opts: MailSourceSyncOpts): Promise<MailSyncSummary> {
    const client = this.requireClient();
    const signal = opts.signal;
    const log = opts.onProgress;
    const since = sinceDate(opts.windowDays);
    const caps = this.caps;
    let fetched = 0;
    let batches = 0;
    let partial = false;
    let partialError: string | null = null;
    const rolesSynced: MailSourceRole[] = [];

    if (!this.discovery) await this.discover();
    const roles = this.rolesToSync();
    if (!this.discovery?.usingAllMail) {
      log?.("system", t("sync.allMailHiddenFallback"));
    }

    for (const { role, path, folder } of roles) {
      throwIfSyncCanceled(signal);
      if (!client.usable) {
        partial = true;
        partialError = t("sync.sentSkippedDeadConnection");
        break;
      }
      try {
        const n = await this.syncMailbox({
          client,
          role,
          path,
          folder,
          opts,
          since,
        });
        fetched += n.fetched;
        batches += n.batches;
        rolesSynced.push(role);
        if (n.stoppedEarly || n.hadBodyFailures) {
          partial = true;
          partialError =
            partialError ||
            (n.stoppedEarly
              ? t("sync.sentSkippedDeadConnection")
              : t("sync.bodyFetchPartial"));
        }
      } catch (err) {
        throwIfSyncCanceled(signal);
        const msg = err instanceof Error ? err.message : String(err);
        // Inbox/All: keep committed batches; mark partial instead of failing the
        // whole job (derive + classify_retry can still drain what we have).
        partial = true;
        partialError =
          role === "inbox" || role === "all"
            ? t("sync.fetchBatchFailed", { folder: role, msg })
            : t("sync.sentReadFailed", { path, msg });
        log?.("err", partialError);
        if (role === "inbox" || role === "all") break;
      }
    }

    if (
      !this.discovery?.usingAllMail &&
      roles.some((r) => r.role === "sent") &&
      !rolesSynced.includes("sent") &&
      !partial
    ) {
      partial = true;
      partialError = partialError || t("sync.sentNotFound");
    }

    return {
      fetched,
      batches,
      usingAllMail: Boolean(this.discovery?.usingAllMail),
      partial,
      partialError,
      capabilities: caps,
      rolesSynced,
    };
  }

  private async syncMailbox(args: {
    client: ImapFlow;
    role: MailSourceRole;
    path: string;
    folder: MailFolder;
    opts: MailSourceSyncOpts;
    since: Date;
  }): Promise<{
    fetched: number;
    batches: number;
    stoppedEarly: boolean;
    hadBodyFailures: boolean;
  }> {
    const { client, role, path, folder, opts, since } = args;
    const log = opts.onProgress;
    const signal = opts.signal;
    log?.("curl", t("sync.readingFolder", { folder: role.toUpperCase(), mailbox: path }));

    const lock = await client.getMailboxLock(path);
    let fetched = 0;
    let batches = 0;
    let hadBodyFailures = false;
    try {
      const uidValidity = uidValidityOf(client);
      const stored = opts.getCursor(role);
      const mode = opts.mode;
      const canIncremental =
        mode === "incremental" &&
        stored &&
        stored.uidValidity === uidValidity &&
        stored.mailboxPath === path &&
        stored.lastUid > 0;

      let uids: number[] = [];
      if (canIncremental && stored) {
        const fromUid = stored.lastUid + 1;
        const hw = highWaterUid(client);
        if (hw > 0 && fromUid > hw) {
          const retryOnly = (opts.listBodyRetryUids?.(role) || []).filter(
            (u) => typeof u === "number" && u > 0,
          );
          if (!retryOnly.length) {
            log?.(
              "ok",
              t("sync.incrementalEmpty", {
                folder: role.toUpperCase(),
                cursor: stored.lastUid,
              }),
            );
            // Park cursor at high-water on clean empty incremental.
            await opts.onBatch({
              role,
              mailboxPath: path,
              uidValidity,
              mails: [],
              commitLastUid: Math.max(stored.lastUid, hw),
              highestModseq: highestModseqOf(client),
              failures: [],
              abandonedUids: [],
            });
            batches += 1;
            return {
              fetched: 0,
              batches,
              stoppedEarly: false,
              hadBodyFailures: false,
            };
          }
          uids = retryOnly;
        } else {
          uids = await searchUids(client, { uid: `${fromUid}:*` }, signal);
          uids = uids.filter((u) => u > stored.lastUid);
        }
      } else {
        if (mode === "incremental") {
          log?.(
            "think",
            t("sync.windowSync", {
              folder: role.toUpperCase(),
              why: !stored
                ? t("sync.whyNoCursor")
                : stored.uidValidity !== uidValidity
                  ? t("sync.whyUidValidity")
                  : stored.mailboxPath !== path
                    ? t("sync.whyMailboxChanged")
                    : t("sync.whyCursorEmpty"),
            }),
          );
        } else {
          log?.(
            "think",
            t("sync.hardSyncWindow", { folder: role.toUpperCase() }),
          );
        }
        uids = await searchUids(client, { since }, signal);
      }

      if (!uids.length) {
        const retryOnly = (opts.listBodyRetryUids?.(role) || []).filter(
          (u) => typeof u === "number" && u > 0,
        );
        if (!retryOnly.length) {
          const prev = stored?.lastUid ?? 0;
          await opts.onBatch({
            role,
            mailboxPath: path,
            uidValidity,
            mails: [],
            commitLastUid: prev,
            highestModseq: highestModseqOf(client),
            failures: [],
            abandonedUids: [],
          });
          batches += 1;
          return {
            fetched: 0,
            batches,
            stoppedEarly: false,
            hadBodyFailures: false,
          };
        }
        uids = retryOnly;
      }

      const retryUids = (opts.listBodyRetryUids?.(role) || []).filter(
        (u) => typeof u === "number" && u > 0,
      );
      if (retryUids.length) {
        log?.(
          "think",
          t("sync.bodyRetryQueued", { count: retryUids.length }),
        );
      }
      uids = [...uids, ...retryUids];

      log?.(
        "think",
        t("sync.messageCount", { folder: role.toUpperCase(), count: uids.length }),
      );

      const sorted = [...new Set(uids)].sort((a, b) => a - b);
      let runningLast = stored?.lastUid ?? 0;
      let stoppedEarly = false;

      for (let i = 0; i < sorted.length; i += FETCH_BATCH_SIZE) {
        throwIfSyncCanceled(signal);
        if (!client.usable) {
          stoppedEarly = true;
          break;
        }
        const chunk = sorted.slice(i, i + FETCH_BATCH_SIZE);
        const { mails, failures } = await fetchUidBatch(
          client,
          role,
          folder,
          chunk,
          opts.userEmail,
          log,
          signal,
          { doneBefore: i, total: sorted.length },
        );

        const abandonedUids: number[] = [];
        const hardFailures: { uid: number; error: string }[] = [];
        for (const f of failures) {
          const prior = opts.getFailureAttempts?.(role, f.uid) ?? 0;
          if (prior + 1 >= FETCH_ABANDON_AFTER) {
            abandonedUids.push(f.uid);
          } else {
            hardFailures.push(f);
          }
        }

        // Body-failed but meta-ok mails were still returned; only count
        // completely missing UIDs as hard failures for contiguous stop.
        const fetchedUids = mails
          .map((m) => m.gmailUid || 0)
          .filter((n) => n > 0);
        const missingFailed = hardFailures.filter(
          (f) => !fetchedUids.includes(f.uid),
        );

        const commitLastUid = contiguousLastUidFromFetched({
          prevLastUid: runningLast,
          fetchedUids,
          failedUids: missingFailed.map((f) => f.uid),
          abandonedUids,
        });

        const batch: MailFetchBatch = {
          role,
          mailboxPath: path,
          uidValidity,
          mails,
          commitLastUid,
          highestModseq: highestModseqOf(client),
          failures: failures,
          abandonedUids,
        };
        await opts.onBatch(batch);
        runningLast = commitLastUid;
        fetched += mails.length;
        batches += 1;

        if (
          failures.length > 0 ||
          mails.some((m) => m.bodyState === "failed")
        ) {
          hadBodyFailures = true;
        }
        if (!client.usable) {
          stoppedEarly = true;
          break;
        }
      }

      return { fetched, batches, stoppedEarly, hadBodyFailures };
    } finally {
      try {
        lock.release();
      } catch {
        /* closed */
      }
    }
  }

  async scanMeta(opts: MailSourceMetaOpts): Promise<MailSourceMetaResult> {
    const client = this.requireClient();
    if (!this.discovery) await this.discover();
    const roles = this.rolesToSync();
    const labelDeltas: LabelDelta[] = [];
    const gone: GoneMark[] = [];
    const restored: MailSourceMetaResult["restored"] = [];
    const scannedRoles: MailSourceRole[] = [];
    const highestModseqByRole: Partial<Record<MailSourceRole, string | null>> =
      {};
    const since = sinceDate(opts.windowDays);

    for (const { role, path } of roles) {
      throwIfSyncCanceled(opts.signal);
      const stored = opts.getCursor(role);
      // Caller decides schedule (force / 6h). Always run when invoked.
      const lock = await client.getMailboxLock(path);
      try {
        scannedRoles.push(role);
        const uidValidity = uidValidityOf(client);
        if (stored && stored.uidValidity !== uidValidity) {
          // UIDVALIDITY changed — skip gone diff; next sync does window rescan.
          highestModseqByRole[role] = highestModseqOf(client);
          continue;
        }

        // CONDSTORE label delta (Gmail supports CONDSTORE; MODSEQ on label
        // change is uncertain — UID set-diff below is the safety net).
        if (this.caps.condstore && stored?.highestModseq) {
          try {
            const changed = await withTimeout(
              client.fetchAll(
                "1:*",
                { uid: true, labels: true, emailId: true, flags: true },
                {
                  uid: true,
                  changedSince: BigInt(stored.highestModseq),
                },
              ),
              FETCH_BATCH_MS,
              `${role} condstore`,
            );
            for (const m of changed) {
              labelDeltas.push({
                role,
                uid: m.uid,
                gmMsgid: m.emailId ? String(m.emailId) : null,
                labels: labelsToArray(m.labels),
                highestModseq: m.modseq != null ? String(m.modseq) : null,
              });
            }
          } catch (err) {
            opts.onProgress?.(
              "err",
              t("sync.condstoreFailed", {
                role,
                msg: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        }

        // UID set-diff within window (Gmail has no QRESYNC).
        const liveUids = await searchUids(client, { since }, opts.signal);
        const liveSet = new Set(liveUids);
        const known = opts.listKnownUids(role);
        for (const k of known.filter((x) => x.uid > 0)) {
          if (!liveSet.has(k.uid)) {
            gone.push({
              role,
              gmMsgid: k.gmMsgid,
              uid: k.uid,
              reason: "expunged",
            });
          } else {
            restored.push({
              gmMsgid: k.gmMsgid,
              uid: k.uid,
              role,
            });
          }
        }

        highestModseqByRole[role] = highestModseqOf(client);
        void opts.force;
      } finally {
        try {
          lock.release();
        } catch {
          /* */
        }
      }
    }

    return {
      labelDeltas,
      gone,
      restored,
      scannedRoles,
      highestModseqByRole,
    };
  }
}

/** Convenience: open, sync, close. */
export async function fetchViaGmailImapSource(
  address: string,
  appPassword: string,
  opts: MailSourceSyncOpts & { windowDays?: number },
): Promise<MailSyncSummary> {
  const src = new GmailImapSource(address, appPassword);
  const onAbort = () => {
    void src.close();
  };
  if (opts.signal) {
    if (opts.signal.aborted) throwIfSyncCanceled(opts.signal);
    opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    await src.open();
    return await src.sync({
      ...opts,
      windowDays: opts.windowDays ?? WINDOW_DAYS,
    });
  } finally {
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    await src.close();
  }
}

/* ── Draft helpers (moved from lib/tracker/imap.ts) ─────────────────── */

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
  /** Stable Message-ID we generate and persist (<cmae-{uuid}@cmae.local>). */
  messageId?: string;
  /** X-CMAE-Draft-Id header (= gmail_drafts.id). */
  draftId?: string;
};

/** One message in the Drafts mailbox (full scan for reconcile). */
export type DraftMailboxMeta = {
  uid: number;
  uidValidity: string;
  gmMsgid: string | null;
  gmThrid: string | null;
  messageIdHdr: string | null;
  cmaeDraftId: string | null;
  subject: string;
  toAddr: string;
};

function wrapBase64(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

function encodeHeaderFilename(name: string): string {
  const safe = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return safe.trim() || "CV.pdf";
}

function buildRfc822(draft: DraftPayload): Buffer {
  const attachments = draft.attachments?.filter((a) => a.buffer?.length) || [];
  const messageId =
    draft.messageId?.trim() ||
    `<cmae-draft-${Date.now()}@cmae.local>`;
  const common = [
    `From: ${draft.from}`,
    `To: ${draft.to}`,
    `Subject: ${draft.subject}`,
    "MIME-Version: 1.0",
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
  ];
  if (draft.draftId) {
    common.push(`X-CMAE-Draft-Id: ${draft.draftId}`);
  }
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

export type AppendDraftResult = {
  ok: true;
  draftsUrl: string;
  uid: number | null;
  uidValidity: string | null;
  gmMsgid: string | null;
  gmThrid: string | null;
};

export async function appendDraft(
  address: string,
  appPassword: string,
  draft: DraftPayload,
): Promise<AppendDraftResult> {
  return withClient(address, appPassword, async (client) => {
    const draftsPath = await findSpecialMailbox(client, "\\Drafts");
    if (!draftsPath) {
      throw new Error(t("tracker.error.gmailDraftsFolder"));
    }
    const raw = buildRfc822(draft);
    const appended = await client.append(draftsPath, raw, ["\\Draft"]);
    const uid =
      appended && typeof appended === "object" && "uid" in appended
        ? Number((appended as { uid?: number }).uid) || null
        : null;
    const uidValidity =
      appended && typeof appended === "object" && "uidValidity" in appended
        ? String((appended as { uidValidity?: unknown }).uidValidity ?? "") ||
          null
        : null;

    let gmMsgid: string | null = null;
    let gmThrid: string | null = null;
    if (uid) {
      const lock = await client.getMailboxLock(draftsPath);
      try {
        const msg = await client.fetchOne(
          String(uid),
          { uid: true, emailId: true, threadId: true },
          { uid: true },
        );
        if (msg && typeof msg === "object") {
          const m = msg as { emailId?: string; threadId?: string | number };
          gmMsgid = m.emailId ? String(m.emailId) : null;
          gmThrid = m.threadId != null ? String(m.threadId) : null;
        }
      } finally {
        lock.release();
      }
    }

    return {
      ok: true as const,
      draftsUrl: gmailDraftsFolderUrl(address),
      uid,
      uidValidity: uidValidity || uidValidityOf(client) || null,
      gmMsgid,
      gmThrid,
    };
  });
}

/**
 * Full Drafts mailbox scan (typically small). Used by drafts_reconcile.
 */
export async function listAllDraftMetas(
  address: string,
  appPassword: string,
): Promise<DraftMailboxMeta[]> {
  return withClient(address, appPassword, async (client) => {
    const draftsPath = await findSpecialMailbox(client, "\\Drafts");
    if (!draftsPath) return [];
    const lock = await client.getMailboxLock(draftsPath);
    try {
      const uidValidity = uidValidityOf(client);
      const out: DraftMailboxMeta[] = [];
      for await (const msg of client.fetch("1:*", {
        uid: true,
        envelope: true,
        emailId: true,
        threadId: true,
        headers: ["Message-ID", "X-CMAE-Draft-Id"],
      })) {
        const hdrs = parseHeaderBlock(
          Buffer.isBuffer(msg.headers) ? msg.headers : undefined,
        );
        const messageIdHdr =
          (msg.envelope?.messageId || "").trim() ||
          hdrs["message-id"] ||
          null;
        const cmaeDraftId = hdrs["x-cmae-draft-id"]?.trim() || null;
        out.push({
          uid: msg.uid,
          uidValidity,
          gmMsgid: msg.emailId ? String(msg.emailId) : null,
          gmThrid: msg.threadId != null ? String(msg.threadId) : null,
          messageIdHdr,
          cmaeDraftId,
          subject: msg.envelope?.subject || "",
          toAddr: addrList(msg.envelope?.to),
        });
      }
      return out;
    } finally {
      lock.release();
    }
  });
}

/**
 * Crash recovery: find a draft by our Message-ID header.
 */
export async function searchDraftByMessageId(
  address: string,
  appPassword: string,
  messageIdHdr: string,
): Promise<DraftMailboxMeta | null> {
  const needle = messageIdHdr.trim();
  if (!needle || needle.startsWith("legacy:")) return null;
  return withClient(address, appPassword, async (client) => {
    const draftsPath = await findSpecialMailbox(client, "\\Drafts");
    if (!draftsPath) return null;
    const lock = await client.getMailboxLock(draftsPath);
    try {
      const uidValidity = uidValidityOf(client);
      const uids = await client.search(
        { header: { "Message-ID": needle } },
        { uid: true },
      );
      if (!uids || !Array.isArray(uids) || !uids.length) return null;
      const uid = Number(uids[0]);
      if (!uid) return null;
      const msg = await client.fetchOne(
        String(uid),
        {
          uid: true,
          envelope: true,
          emailId: true,
          threadId: true,
          headers: ["Message-ID", "X-CMAE-Draft-Id"],
        },
        { uid: true },
      );
      if (!msg || typeof msg !== "object") return null;
      const m = msg as {
        uid: number;
        emailId?: string;
        threadId?: string | number;
        envelope?: { subject?: string | null; to?: Parameters<typeof addrList>[0]; messageId?: string | null };
        headers?: Buffer;
      };
      const hdrs = parseHeaderBlock(
        Buffer.isBuffer(m.headers) ? m.headers : undefined,
      );
      return {
        uid: m.uid,
        uidValidity,
        gmMsgid: m.emailId ? String(m.emailId) : null,
        gmThrid: m.threadId != null ? String(m.threadId) : null,
        messageIdHdr:
          (m.envelope?.messageId || "").trim() || hdrs["message-id"] || needle,
        cmaeDraftId: hdrs["x-cmae-draft-id"]?.trim() || null,
        subject: m.envelope?.subject || "",
        toAddr: addrList(m.envelope?.to),
      };
    } finally {
      lock.release();
    }
  });
}

/** Remove a CMAE draft from Gmail Drafts. False when it is already gone. */
export async function deleteDraftByMessageId(
  address: string,
  appPassword: string,
  messageIdHdr: string,
): Promise<boolean> {
  const needle = messageIdHdr.trim();
  if (!needle || needle.startsWith("legacy:")) return false;
  return withClient(address, appPassword, async (client) => {
    const draftsPath = await findSpecialMailbox(client, "\\Drafts");
    if (!draftsPath) {
      throw new Error(t("tracker.error.gmailDraftsFolder"));
    }
    const lock = await client.getMailboxLock(draftsPath);
    try {
      const uids = await client.search(
        { header: { "Message-ID": needle } },
        { uid: true },
      );
      if (!uids || !Array.isArray(uids) || !uids.length) return false;
      await client.messageDelete(uids, { uid: true });
      return true;
    } finally {
      lock.release();
    }
  });
}

export type ImapSyncMode = "incremental" | "hard";
export type { MailSourceCursor };
