import {
  BODY_MAX_BYTES,
  classifyDirection,
  contiguousLastUidFromFetched,
  folderFromLabels,
  normalizeAccountEmail,
  type GoneMark,
  type LabelDelta,
  type MailFetchBatch,
  type MailSource,
  type MailSourceMetaOpts,
  type MailSourceMetaResult,
  type MailSourceRole,
  type MailSourceSyncOpts,
  type MailSyncSummary,
  type MailboxDiscovery,
  type SourceMail,
} from "./source";
import { headersHash } from "./body-extract";

export type FakeStoredMail = {
  uid: number;
  gmMsgid: string;
  threadId?: string;
  labels: string[];
  fromAddr: string;
  toAddr: string;
  ccAddr?: string;
  subject: string;
  internalDate: string;
  headerDate?: string;
  bodyText: string;
  messageId?: string;
  inReplyTo?: string;
  /** Soft-deleted from mailbox (gone). */
  present?: boolean;
};

/** In-memory Gmail Drafts message for Faz 5 reconcile tests. */
export type FakeDraftMail = {
  uid: number;
  gmMsgid: string;
  threadId?: string;
  messageId: string;
  cmaeDraftId?: string;
  subject: string;
  toAddr: string;
  present?: boolean;
};

/**
 * In-memory MailSource for unit / integration tests (no IMAP).
 * Supports All Mail, UIDVALIDITY reset, label changes, and gone detection.
 */
export class FakeMailSource implements MailSource {
  readonly accountId: string;
  private readonly userEmail: string;
  usingAllMail: boolean;
  uidValidity = "1";
  highestModseq = BigInt(1);
  condstore = true;
  private openFlag = false;
  private mails: FakeStoredMail[];
  private drafts: FakeDraftMail[];
  private mailboxPath: string;
  private nextDraftUid = 1;

  constructor(opts: {
    userEmail: string;
    mails?: FakeStoredMail[];
    drafts?: FakeDraftMail[];
    usingAllMail?: boolean;
  }) {
    this.userEmail = normalizeAccountEmail(opts.userEmail);
    this.accountId = this.userEmail;
    this.mails = (opts.mails || []).map((m) => ({
      present: true,
      ...m,
    }));
    this.drafts = (opts.drafts || []).map((d) => ({
      present: true,
      ...d,
    }));
    this.nextDraftUid =
      this.drafts.reduce((m, d) => Math.max(m, d.uid), 0) + 1;
    this.usingAllMail = opts.usingAllMail ?? true;
    this.mailboxPath = this.usingAllMail ? "[Gmail]/All Mail" : "INBOX";
  }

  seed(mails: FakeStoredMail[]) {
    this.mails = mails.map((m) => ({ present: true, ...m }));
  }

  /** Archive / trash simulation — mail stays in Fake store flag present=false. */
  markGone(gmMsgid: string) {
    const m = this.mails.find((x) => x.gmMsgid === gmMsgid);
    if (m) m.present = false;
  }

  restore(gmMsgid: string) {
    const m = this.mails.find((x) => x.gmMsgid === gmMsgid);
    if (m) m.present = true;
  }

  setLabels(gmMsgid: string, labels: string[]) {
    const m = this.mails.find((x) => x.gmMsgid === gmMsgid);
    if (m) {
      m.labels = labels;
      this.highestModseq += BigInt(1);
    }
  }

  resetUidValidity() {
    this.uidValidity = String(Number(this.uidValidity) + 1);
    // Remap UIDs as Gmail would after UV change (keep gmMsgid).
    let next = 1;
    for (const m of this.mails) {
      if (m.present !== false) m.uid = next++;
    }
  }

  /** APPEND to Drafts — returns meta for gmail_drafts.present. */
  appendDraft(opts: {
    messageId: string;
    cmaeDraftId?: string;
    subject: string;
    toAddr: string;
    threadId?: string;
  }): FakeDraftMail {
    const d: FakeDraftMail = {
      uid: this.nextDraftUid++,
      gmMsgid: `gm-draft-${Date.now()}-${this.nextDraftUid}`,
      threadId: opts.threadId || `thrid-${opts.cmaeDraftId || opts.messageId}`,
      messageId: opts.messageId,
      cmaeDraftId: opts.cmaeDraftId,
      subject: opts.subject,
      toAddr: opts.toAddr,
      present: true,
    };
    this.drafts.push(d);
    return d;
  }

  listDraftMetas(): Array<{
    uid: number;
    uidValidity: string;
    gmMsgid: string | null;
    gmThrid: string | null;
    messageIdHdr: string | null;
    cmaeDraftId: string | null;
    subject: string;
    toAddr: string;
  }> {
    return this.drafts
      .filter((d) => d.present !== false)
      .map((d) => ({
        uid: d.uid,
        uidValidity: this.uidValidity,
        gmMsgid: d.gmMsgid,
        gmThrid: d.threadId ?? null,
        messageIdHdr: d.messageId,
        cmaeDraftId: d.cmaeDraftId ?? null,
        subject: d.subject,
        toAddr: d.toAddr,
      }));
  }

  /** User deleted draft in Gmail web. */
  deleteDraft(gmMsgidOrMessageId: string) {
    const d = this.drafts.find(
      (x) =>
        x.gmMsgid === gmMsgidOrMessageId ||
        x.messageId === gmMsgidOrMessageId ||
        x.cmaeDraftId === gmMsgidOrMessageId,
    );
    if (d) d.present = false;
  }

  /**
   * User sent draft from Gmail — remove from Drafts, add \\Sent in All Mail.
   * Optionally rewrite gmMsgid (web edit uncertainty).
   */
  sendDraft(
    gmMsgidOrMessageId: string,
    opts?: { newGmMsgid?: string; keepMessageId?: boolean },
  ): FakeStoredMail | null {
    const d = this.drafts.find(
      (x) =>
        x.gmMsgid === gmMsgidOrMessageId ||
        x.messageId === gmMsgidOrMessageId ||
        x.cmaeDraftId === gmMsgidOrMessageId,
    );
    if (!d || d.present === false) return null;
    d.present = false;
    const uid =
      this.mails.reduce((m, x) => Math.max(m, x.uid), 0) + 1;
    const sent: FakeStoredMail = {
      uid,
      gmMsgid: opts?.newGmMsgid || d.gmMsgid,
      threadId: d.threadId,
      labels: ["\\Sent"],
      fromAddr: this.userEmail,
      toAddr: d.toAddr,
      subject: d.subject,
      internalDate: new Date().toISOString(),
      bodyText: "",
      messageId:
        opts?.keepMessageId === false
          ? `<sent-${Date.now()}@fake.local>`
          : d.messageId,
      present: true,
    };
    this.mails.push(sent);
    return sent;
  }

  /** Gmail web edit: new X-GM-MSGID, same thrid. */
  editDraft(gmMsgid: string, patch: { subject?: string; newGmMsgid?: string }) {
    const d = this.drafts.find((x) => x.gmMsgid === gmMsgid && x.present !== false);
    if (!d) return;
    if (patch.subject) d.subject = patch.subject;
    if (patch.newGmMsgid) d.gmMsgid = patch.newGmMsgid;
  }

  async open(): Promise<void> {
    this.openFlag = true;
  }

  async close(): Promise<void> {
    this.openFlag = false;
  }

  async discover(): Promise<MailboxDiscovery> {
    return {
      all: this.usingAllMail ? this.mailboxPath : null,
      inbox: "INBOX",
      sent: this.usingAllMail ? null : "[Gmail]/Sent Mail",
      drafts: "[Gmail]/Drafts",
      usingAllMail: this.usingAllMail,
    };
  }

  private toSourceMail(m: FakeStoredMail, role: MailSourceRole): SourceMail {
    const folder = folderFromLabels(m.labels, "INBOX");
    const dateIso = m.internalDate;
    const body = m.bodyText.slice(0, 8000);
    const truncated = Buffer.byteLength(m.bodyText, "utf8") > BODY_MAX_BYTES;
    return {
      messageId: m.messageId || `<${m.gmMsgid}@fake.local>`,
      gmMsgid: m.gmMsgid,
      threadId: m.threadId ?? null,
      gmailUid: m.uid,
      folder,
      sourceRole: role,
      fromAddr: m.fromAddr,
      toAddr: m.toAddr,
      ccAddr: m.ccAddr || "",
      subject: m.subject,
      dateIso,
      headerDate: m.headerDate || m.internalDate,
      internalDate: m.internalDate,
      snippet: body.slice(0, 240),
      bodyText: body,
      bodyState: truncated ? "truncated" : "ok",
      headersHash: headersHash(m.fromAddr, m.toAddr, m.subject, dateIso),
      labels: m.labels,
      direction: classifyDirection(m.fromAddr, m.toAddr, this.userEmail),
      inReplyTo: m.inReplyTo || null,
      referencesHdr: null,
      autoFlags: null,
    };
  }

  async sync(opts: MailSourceSyncOpts): Promise<MailSyncSummary> {
    if (!this.openFlag) await this.open();
    const role: MailSourceRole = this.usingAllMail ? "all" : "inbox";
    const stored = opts.getCursor(role);
    const present = this.mails.filter((m) => m.present !== false);
    const sinceMs =
      Date.now() - opts.windowDays * 24 * 60 * 60 * 1000;

    let candidates = present.filter(
      (m) => Date.parse(m.internalDate) >= sinceMs || opts.mode === "hard",
    );

    const canIncremental =
      opts.mode === "incremental" &&
      stored &&
      stored.uidValidity === this.uidValidity &&
      stored.lastUid > 0;

    if (canIncremental && stored) {
      candidates = candidates.filter((m) => m.uid > stored.lastUid);
    }

    candidates.sort((a, b) => a.uid - b.uid);
    const BATCH = 50;
    let fetched = 0;
    let batches = 0;
    let runningLast = stored?.lastUid ?? 0;

    if (!candidates.length) {
      const hw = present.reduce((m, x) => Math.max(m, x.uid), 0);
      await opts.onBatch({
        role,
        mailboxPath: this.mailboxPath,
        uidValidity: this.uidValidity,
        mails: [],
        commitLastUid: canIncremental
          ? Math.max(runningLast, hw)
          : runningLast,
        highestModseq: String(this.highestModseq),
        failures: [],
        abandonedUids: [],
      });
      batches = 1;
    } else {
      for (let i = 0; i < candidates.length; i += BATCH) {
        const chunk = candidates.slice(i, i + BATCH);
        const mails = chunk.map((m) => this.toSourceMail(m, role));
        const fetchedUids = mails.map((m) => m.gmailUid!).filter(Boolean);
        const commitLastUid = contiguousLastUidFromFetched({
          prevLastUid: runningLast,
          fetchedUids,
          failedUids: [],
          abandonedUids: [],
        });
        const batch: MailFetchBatch = {
          role,
          mailboxPath: this.mailboxPath,
          uidValidity: this.uidValidity,
          mails,
          commitLastUid,
          highestModseq: String(this.highestModseq),
          failures: [],
          abandonedUids: [],
        };
        await opts.onBatch(batch);
        runningLast = commitLastUid;
        fetched += mails.length;
        batches += 1;
      }
    }

    return {
      fetched,
      batches,
      usingAllMail: this.usingAllMail,
      partial: false,
      partialError: null,
      capabilities: { condstore: this.condstore, qresync: false },
      rolesSynced: [role],
    };
  }

  async scanMeta(opts: MailSourceMetaOpts): Promise<MailSourceMetaResult> {
    const role: MailSourceRole = this.usingAllMail ? "all" : "inbox";
    const stored = opts.getCursor(role);
    const labelDeltas: LabelDelta[] = [];
    const gone: GoneMark[] = [];
    const restored: MailSourceMetaResult["restored"] = [];

    if (this.condstore && stored?.highestModseq) {
      // All current labels as "delta" when modseq advanced — simplified.
      for (const m of this.mails.filter((x) => x.present !== false)) {
        labelDeltas.push({
          role,
          uid: m.uid,
          gmMsgid: m.gmMsgid,
          labels: m.labels,
          highestModseq: String(this.highestModseq),
        });
      }
    }

    const live = new Set(
      this.mails.filter((m) => m.present !== false).map((m) => m.uid),
    );
    for (const k of opts.listKnownUids(role)) {
      if (k.uid > 0 && !live.has(k.uid)) {
        gone.push({
          role,
          gmMsgid: k.gmMsgid,
          uid: k.uid,
          reason: "expunged",
        });
      } else if (k.uid > 0 && live.has(k.uid)) {
        restored.push({ gmMsgid: k.gmMsgid, uid: k.uid, role });
      }
    }

    return {
      labelDeltas,
      gone,
      restored,
      scannedRoles: [role],
      highestModseqByRole: { [role]: String(this.highestModseq) },
    };
  }
}
