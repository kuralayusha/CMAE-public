/**
 * Normal sync derivation: dirty derive_state queue → assign → facts.
 * Never deletes items / never full rebuild. Chunks of 200.
 */

import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mailMessages, trackerItems } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { getSettingsRow } from "@/lib/settings/service";
import {
  classifyMailSignals,
} from "../agents/mail-signals";
import {
  routeIncrementalMails,
  type ExistingItemBrief,
} from "../agents/incremental-route";
import { throwIfSyncCanceled } from "../cancel";
import { normalizeMailText } from "../signals";
import type { MailBrief } from "../match";
import type { MailIntentMap } from "../mail-kind";
import {
  emailDomain,
  parseEmailAddr,
  sameCompanyIdentity,
} from "../identity";
import type { SyncProgressFn } from "../types";
import {
  drainAmbiguousRoutingSkips,
  getAssignment,
  markRoutingSkipAsNoise,
  markUnassigned,
  tryRuleBasedAssign,
  writeAssignment,
} from "./assign";
import { resolveIntentFast, upsertMailIntent } from "./intent";
import { suggestTwinMerges } from "./merge-suggestions";
import { isNoiseMail, parseAutoFlags } from "./noise";
import { refreshItemFacts } from "./refresh-item";

/** Architecture: process dirty queue in chunks of 200; no 25-mail full-rebuild threshold. */
export const DERIVE_CHUNK_SIZE = 200;

function toBrief(m: typeof mailMessages.$inferSelect): MailBrief {
  return {
    id: m.id,
    folder: m.folder,
    fromAddr: m.fromAddr,
    toAddr: m.toAddr,
    subject: m.subject,
    dateIso: m.internalDate || m.dateIso,
    snippet: m.snippet,
    threadId: m.threadId,
    bodyPreview: normalizeMailText(m.bodyText || m.snippet || "").slice(0, 600),
  };
}

function companyFromDomain(domain: string): string {
  const base = domain.split(".")[0] || domain;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function counterpartyDomain(
  mail: { folder: string; fromAddr: string; toAddr: string },
  userEmail: string,
): string | null {
  if (mail.folder === "SENT") {
    for (const part of mail.toAddr.split(",")) {
      const d = emailDomain(parseEmailAddr(part));
      if (d) return d;
    }
    return null;
  }
  const from = parseEmailAddr(mail.fromAddr);
  if (from && from !== userEmail) return emailDomain(from);
  return null;
}

function existingItemBriefs(): ExistingItemBrief[] {
  const db = getDb();
  const items = db
    .select()
    .from(trackerItems)
    .all()
    .filter((i) => !i.deletedAt);
  return items.map((item) => ({
    id: item.id,
    company: item.company,
    position: item.position,
    status: item.status,
    primaryTo: item.primaryTo,
    lastSubject: null,
  }));
}

/** Prefer attach when AI says create but same company already exists (this run or DB). */
function findExistingCompanyItemId(
  company: string,
  preferIds?: Set<number>,
): number | null {
  const db = getDb();
  const items = db
    .select()
    .from(trackerItems)
    .all()
    .filter((i) => !i.deletedAt);
  if (preferIds?.size) {
    for (const item of items) {
      if (
        preferIds.has(item.id) &&
        sameCompanyIdentity(item.company, company)
      ) {
        return item.id;
      }
    }
  }
  for (const item of items) {
    if (sameCompanyIdentity(item.company, company)) return item.id;
  }
  return null;
}

function createItemForMail(
  mail: typeof mailMessages.$inferSelect,
  userEmail: string,
  opts?: { company?: string | null; position?: string | null },
): number {
  const db = getDb();
  const domain = counterpartyDomain(mail, userEmail);
  const company =
    (opts?.company || "").trim() ||
    (domain ? companyFromDomain(domain) : "") ||
    mail.subject.replace(/^(re|aw|wg|fwd):\s*/i, "").slice(0, 80) ||
    t("tracker.unknownCompany");
  const position = (opts?.position || "").trim() || null;
  const primaryTo =
    mail.folder === "SENT"
      ? mail.toAddr.split(",")[0]?.trim() || null
      : parseEmailAddr(mail.fromAddr);
  const now = new Date().toISOString();
  const inserted = db
    .insert(trackerItems)
    .values({
      company,
      position,
      status: "in_progress",
      sentiment: null,
      waitingOn: mail.folder === "SENT" ? "them" : "us",
      followUpCount: 0,
      lastOutboundAt: mail.folder === "SENT" ? mail.dateIso : null,
      lastInboundAt: mail.folder === "INBOX" ? mail.dateIso : null,
      nextFollowUpAt: null,
      ignored: 0,
      workspaceFolder: null,
      researchJobId: null,
      primaryTo,
      notesJson: JSON.stringify({ notes: "derive create" }),
      userState: "active",
      aiStatus: "in_progress",
      updatedAt: now,
      createdAt: now,
    })
    .returning({ id: trackerItems.id })
    .get();
  if (!inserted) throw new Error(t("tracker.error.createItemFailed"));
  writeAssignment({
    mailId: mail.id,
    itemId: inserted.id,
    source: "ai",
    confidence: 0.8,
    mail,
  });
  return inserted.id;
}

function folderLabel(folder: string): string {
  if (folder === "INBOX") return t("mail.folder.inbox");
  if (folder === "SENT") return t("mail.folder.sent");
  return folder;
}

function markDeriveState(
  mailIds: number[],
  state: "done" | "noise" | "needs_classification" | "pending",
): void {
  if (!mailIds.length) return;
  const db = getDb();
  for (const id of mailIds) {
    db.update(mailMessages)
      .set({ deriveState: state })
      .where(eq(mailMessages.id, id))
      .run();
  }
}

export async function derivePendingMails(
  pendingIds: number[],
  opts?: { onProgress?: SyncProgressFn; signal?: AbortSignal },
): Promise<{
  itemCount: number;
  attached: number;
  created: number;
  skipped: number;
  unassigned: number;
}> {
  const log = opts?.onProgress;
  const signal = opts?.signal;
  // Never hold a drizzle handle across IMAP/LLM awaits (onboarding reconcile
  // / path flip can closeDb mid-job).
  let db = getDb();
  const settings = getSettingsRow();
  const followUpDays = settings?.followUpDays ?? 5;
  const userEmail = (settings?.gmailAddress || "").toLowerCase();

  // Older builds parked AI `skip` as unassigned(ambiguous) — drain to noise
  // so the freshness banner only reflects actionable review queues.
  drainAmbiguousRoutingSkips();
  db = getDb();

  const existingCount = db
    .select()
    .from(trackerItems)
    .all()
    .filter((i) => !i.deletedAt).length;

  if (!pendingIds.length) {
    log?.("ok", t("sync.incrementalNoNew"));
    return {
      itemCount: existingCount,
      attached: 0,
      created: 0,
      skipped: 0,
      unassigned: 0,
    };
  }

  throwIfSyncCanceled(signal);

  let attached = 0;
  let created = 0;
  let skipped = 0;
  let unassigned = 0;
  const touched = new Set<number>();
  const allIntents: MailIntentMap = new Map();

  // Process in chunks of 200
  for (let i = 0; i < pendingIds.length; i += DERIVE_CHUNK_SIZE) {
    const chunkIds = pendingIds.slice(i, i + DERIVE_CHUNK_SIZE);
    throwIfSyncCanceled(signal);

    const newMails = db
      .select()
      .from(mailMessages)
      .where(inArray(mailMessages.id, chunkIds))
      .all();

    log?.(
      "think",
      t("sync.incrementalStart", { count: newMails.length }),
    );

    const needsRoute: (typeof mailMessages.$inferSelect)[] = [];
    const needsClassifyBriefs: MailBrief[] = [];
    const chunkNeedsClass = new Set<number>();
    const stateAfter = (
      mail: typeof mailMessages.$inferSelect,
      inNeedsClass: boolean,
    ): "done" | "needs_classification" | "pending" => {
      if (mail.bodyState === "failed") return "pending";
      return inNeedsClass ? "needs_classification" : "done";
    };

    for (const mail of newMails) {
      throwIfSyncCanceled(signal);
      const flags = parseAutoFlags(mail.autoFlags);
      const noise = isNoiseMail({
        subject: mail.subject,
        fromAddr: mail.fromAddr,
        toAddr: mail.toAddr,
        snippet: mail.snippet,
        bodyPreview: normalizeMailText(mail.bodyText || "").slice(0, 600),
        autoFlags: flags,
      });

      if (noise && !flags?.bounce) {
        skipped += 1;
        markDeriveState([mail.id], "noise");
        log?.(
          "system",
          t("sync.incrementalSkippedNoise", {
            subject: mail.subject.slice(0, 60) || t("mail.noSubject"),
          }),
        );
        continue;
      }

      // Fast intent (header / cache / regex)
      const intentResult = resolveIntentFast({
        mailId: mail.id,
        subject: mail.subject,
        body: normalizeMailText(mail.bodyText || mail.snippet || ""),
        fromAddr: mail.fromAddr,
        toAddr: mail.toAddr,
        autoFlagsRaw: mail.autoFlags,
      });
      allIntents.set(mail.id, intentResult.record);
      // Empty/failed body: keep pending so body retry re-derives; don't park
      // forever in needs_classification with header-only text.
      const deferForBody =
        mail.bodyState === "failed" && intentResult.needsClassification;
      if (intentResult.needsClassification && !deferForBody) {
        chunkNeedsClass.add(mail.id);
        needsClassifyBriefs.push(toBrief(mail));
      }

      const already = getAssignment(mail.id);
      if (already) {
        touched.add(already.itemId);
        markDeriveState([mail.id], deferForBody ? "pending" : "done");
        continue;
      }

      const rule = tryRuleBasedAssign(mail, userEmail);
      if (rule.kind === "assigned" || rule.kind === "already") {
        attached += rule.kind === "assigned" ? 1 : 0;
        touched.add(rule.itemId);
        markDeriveState([mail.id], deferForBody ? "pending" : "done");
        const item = db
          .select()
          .from(trackerItems)
          .where(eq(trackerItems.id, rule.itemId))
          .get();
        if (rule.kind === "assigned") {
          log?.(
            "ok",
            t("sync.incrementalAttached", {
              company: item?.company || `#${rule.itemId}`,
              folder: folderLabel(mail.folder),
            }),
          );
        }
        continue;
      }

      // Unmatched SENT → visible unassigned queue (architecture §2.6.1)
      if (mail.folder === "SENT") {
        markUnassigned(mail.id, "unmatched_outbound");
        markDeriveState([mail.id], deferForBody ? "pending" : "done");
        unassigned += 1;
        skipped += 1;
        log?.(
          "system",
          t("sync.incrementalQueuedUnmatched", {
            subject: mail.subject.slice(0, 60) || t("mail.noSubject"),
          }),
        );
        continue;
      }

      needsRoute.push(mail);
    }

    // AI intent for provisional regex mails (best-effort; failures leave needs_classification)
    if (needsClassifyBriefs.length) {
      try {
        throwIfSyncCanceled(signal);
        const classified = await classifyMailSignals(needsClassifyBriefs, {
          onProgress: log,
          signal,
        });
        db = getDb();
        for (const [mailId, rec] of classified) {
          allIntents.set(mailId, rec);
          upsertMailIntent({
            mailId,
            intent: rec.intent,
            waitingUntil: rec.waitingUntil,
            source: "ai",
            confidence: 0.9,
          });
          chunkNeedsClass.delete(mailId);
        }
      } catch (err) {
        db = getDb();
        // LLM down: keep regex intents + needs_classification; do not drop mails
        log?.(
          "system",
          t("sync.intentSummary", {
            inbound: needsClassifyBriefs.length,
            ai: 0,
            signals: 0,
          }),
        );
        void err;
      }
    }

    if (needsRoute.length) {
      throwIfSyncCanceled(signal);
      let decisions: Awaited<ReturnType<typeof routeIncrementalMails>>;
      try {
        decisions = await routeIncrementalMails(
          needsRoute.map(toBrief),
          existingItemBriefs(),
          { onProgress: log, signal },
        );
        db = getDb();
      } catch {
        db = getDb();
        // AI unavailable → unassigned queue (visible), preserve rows
        for (const mail of needsRoute) {
          markUnassigned(mail.id, "ai_unavailable");
          markDeriveState(
            [mail.id],
            stateAfter(mail, chunkNeedsClass.has(mail.id)),
          );
          unassigned += 1;
        }
        decisions = new Map();
        needsRoute.length = 0;
      }

      for (const mail of needsRoute) {
        throwIfSyncCanceled(signal);
        const decision = decisions.get(mail.id);
        const action = decision?.action ?? "skip";

        if (action === "attach" && decision?.itemId != null) {
          const item = db
            .select()
            .from(trackerItems)
            .where(eq(trackerItems.id, decision.itemId))
            .get();
          if (!item || item.deletedAt) {
            markUnassigned(mail.id, "ambiguous");
            markDeriveState([mail.id], stateAfter(mail, false));
            unassigned += 1;
            continue;
          }
          writeAssignment({
            mailId: mail.id,
            itemId: decision.itemId,
            source: "ai",
            confidence: 0.75,
            mail,
          });
          attached += 1;
          touched.add(decision.itemId);
          markDeriveState(
            [mail.id],
            stateAfter(mail, chunkNeedsClass.has(mail.id)),
          );
          log?.(
            "ok",
            t("sync.incrementalAttached", {
              company: item.company,
              folder: folderLabel(mail.folder),
            }),
          );
          continue;
        }

        if (action === "create" && decision?.company) {
          // Same company already tracked (incl. created earlier in this chunk)
          // → attach, do not invent duplicate rows (architecture §2.6.1).
          const existingId = findExistingCompanyItemId(
            decision.company,
            touched,
          );
          if (existingId != null) {
            const item = db
              .select()
              .from(trackerItems)
              .where(eq(trackerItems.id, existingId))
              .get();
            writeAssignment({
              mailId: mail.id,
              itemId: existingId,
              source: "ai",
              confidence: 0.8,
              mail,
            });
            attached += 1;
            touched.add(existingId);
            markDeriveState(
              [mail.id],
              stateAfter(mail, chunkNeedsClass.has(mail.id)),
            );
            log?.(
              "ok",
              t("sync.incrementalAttached", {
                company: item?.company || decision.company,
                folder: folderLabel(mail.folder),
              }),
            );
            continue;
          }
          const newId = createItemForMail(mail, userEmail, {
            company: decision.company,
            position: decision.position,
          });
          created += 1;
          touched.add(newId);
          markDeriveState(
            [mail.id],
            stateAfter(mail, chunkNeedsClass.has(mail.id)),
          );
          log?.(
            "ok",
            t("sync.incrementalCreated", { company: decision.company }),
          );
          continue;
        }

        // AI skip = non-job → noise (not permanent unassigned review queue).
        markRoutingSkipAsNoise(mail.id);
        skipped += 1;
        log?.(
          "system",
          t("sync.incrementalSkippedNoise", {
            subject: mail.subject.slice(0, 60) || t("mail.noSubject"),
          }),
        );
      }
    }

    // Mark remaining needs_classification on mails that still need AI upgrade
    // (skip body-failed — those stay pending for body retry).
    if (chunkNeedsClass.size) {
      const ready = [...chunkNeedsClass].filter((id) => {
        const row = newMails.find((m) => m.id === id);
        return row?.bodyState !== "failed";
      });
      markDeriveState(ready, "needs_classification");
      for (const itemId of touched) {
        db.update(trackerItems)
          .set({ needsClassification: 1 })
          .where(eq(trackerItems.id, itemId))
          .run();
      }
    }
  }

  db = getDb();
  for (const itemId of touched) {
    refreshItemFacts(itemId, allIntents, followUpDays, {
      needsClassification: false,
    });
  }

  // Soft twin suggestions only (K3) — never auto-delete
  const proposals = suggestTwinMerges();
  if (proposals > 0) {
    log?.(
      "system",
      t("sync.collapsedTwins", { count: proposals }),
    );
  }

  const itemCount = getDb()
    .select()
    .from(trackerItems)
    .all()
    .filter((i) => !i.deletedAt).length;

  log?.(
    "ok",
    t("sync.incrementalDone", {
      attached,
      created,
      skipped,
      rows: itemCount,
    }),
  );

  return { itemCount, attached, created, skipped, unassigned };
}
