/**
 * Lightweight FakeMailSource checks (no vitest). Run:
 *   npx tsx lib/mail/fake-source-smoke.ts
 */
import {
  classifyDirection,
  contiguousLastUidFromFetched,
} from "./source";
import { FakeMailSource } from "./fake-source";
import type { MailSourceCursor, SourceMail } from "./source";

async function main() {
  const errors: string[] = [];

  const c = contiguousLastUidFromFetched({
    prevLastUid: 0,
    fetchedUids: [1, 2, 4],
    failedUids: [3],
    abandonedUids: [],
  });
  if (c !== 2) errors.push(`contiguous expected 2 got ${c}`);

  const c2 = contiguousLastUidFromFetched({
    prevLastUid: 0,
    fetchedUids: [1, 2, 4],
    failedUids: [],
    abandonedUids: [3],
  });
  if (c2 !== 4) errors.push(`abandoned contiguous expected 4 got ${c2}`);

  if (
    classifyDirection("me@example.com", "other@x.com", "me@example.com") !==
    "out"
  ) {
    errors.push("direction out");
  }
  if (
    classifyDirection("hr@co.com", "me@example.com", "me@example.com") !== "in"
  ) {
    errors.push("direction in");
  }
  if (
    classifyDirection("me@example.com", "me@example.com", "me@example.com") !==
    "self"
  ) {
    errors.push("direction self");
  }

  const src = new FakeMailSource({
    userEmail: "me@example.com",
    mails: [
      {
        uid: 10,
        gmMsgid: "gm-archive",
        labels: ["my-label"], // archived — no \\Inbox
        fromAddr: "hr@co.com",
        toAddr: "me@example.com",
        subject: "Archived reply",
        internalDate: new Date().toISOString(),
        bodyText: "still counts",
      },
      {
        uid: 11,
        gmMsgid: "gm-sent",
        labels: ["\\Sent"],
        fromAddr: "me@example.com",
        toAddr: "hr@co.com",
        subject: "Application",
        internalDate: new Date().toISOString(),
        bodyText: "hello",
      },
    ],
  });

  const cursors = new Map<string, MailSourceCursor>();
  const committed: SourceMail[] = [];
  await src.open();
  await src.sync({
    mode: "hard",
    windowDays: 30,
    userEmail: "me@example.com",
    getCursor: (role) => cursors.get(role) || null,
    onBatch: (batch) => {
      committed.push(...batch.mails);
      cursors.set(batch.role, {
        accountId: src.accountId,
        role: batch.role,
        mailboxPath: batch.mailboxPath,
        uidValidity: batch.uidValidity,
        lastUid: batch.commitLastUid,
        highestModseq: batch.highestModseq,
      });
    },
  });

  if (!committed.some((m) => m.gmMsgid === "gm-archive")) {
    errors.push("archived All Mail message not fetched");
  }
  if (!committed.some((m) => m.folder === "SENT" && m.direction === "out")) {
    errors.push("sent direction/folder");
  }

  src.markGone("gm-archive");
  const meta = await src.scanMeta({
    windowDays: 30,
    userEmail: "me@example.com",
    force: true,
    getCursor: (role) => cursors.get(role) || null,
    listKnownUids: () => [
      { uid: 10, gmMsgid: "gm-archive" },
      { uid: 11, gmMsgid: "gm-sent" },
    ],
  });
  if (!meta.gone.some((g) => g.gmMsgid === "gm-archive")) {
    errors.push("gone detection failed");
  }

  src.resetUidValidity();
  const afterUv: SourceMail[] = [];
  await src.sync({
    mode: "hard",
    windowDays: 30,
    userEmail: "me@example.com",
    getCursor: () => null,
    onBatch: (batch) => {
      afterUv.push(...batch.mails);
    },
  });
  const ids = afterUv.map((m) => m.gmMsgid);
  if (new Set(ids).size !== ids.length) {
    errors.push("UIDVALIDITY reset produced duplicate gmMsgid");
  }

  // Faz 5 drafts lifecycle on FakeMailSource
  const draftSrc = new FakeMailSource({ userEmail: "me@example.com" });
  const d = draftSrc.appendDraft({
    messageId: "<cmae-test@cmae.local>",
    cmaeDraftId: "draft-uuid-1",
    subject: "Hello HR",
    toAddr: "hr@co.com",
  });
  if (draftSrc.listDraftMetas().length !== 1) {
    errors.push("appendDraft should list 1");
  }
  draftSrc.editDraft(d.gmMsgid, { newGmMsgid: "gm-edited", subject: "Hello HR v2" });
  const afterEdit = draftSrc.listDraftMetas()[0];
  if (afterEdit?.gmMsgid !== "gm-edited" || afterEdit.gmThrid !== d.threadId) {
    errors.push("editDraft should change msgid keep thrid");
  }
  draftSrc.deleteDraft("gm-edited");
  if (draftSrc.listDraftMetas().length !== 0) {
    errors.push("deleteDraft should remove from list");
  }
  const d2 = draftSrc.appendDraft({
    messageId: "<cmae-test2@cmae.local>",
    cmaeDraftId: "draft-uuid-2",
    subject: "App",
    toAddr: "hr@co.com",
  });
  const sent = draftSrc.sendDraft(d2.gmMsgid);
  if (!sent || !sent.labels.includes("\\Sent")) {
    errors.push("sendDraft should add \\Sent mail");
  }
  if (draftSrc.listDraftMetas().length !== 0) {
    errors.push("sendDraft should clear drafts");
  }

  if (errors.length) {
    console.error("FAIL", errors);
    process.exit(1);
  }
  console.log("ok: FakeMailSource smoke passed");
}

void main();
