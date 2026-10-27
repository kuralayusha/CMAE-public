/**
 * Conversation AI stages inside derive (architecture §2.6.5–§2.6.10):
 * stage 1 triage → stage 2 identity → stage 3 events. Stage 0 (thread /
 * reply-header attach) runs before this in run-derive; stage 4 is
 * `effective()` on read after facts are refreshed.
 *
 * Bounded: conversations per run are capped, LLM calls are batched and run
 * with limited concurrency; every await is followed by a cancel / fencing
 * check before writing (sync_jobs lease model, §2.5.2).
 */

import { eq, inArray } from "drizzle-orm";
import { getFencingTokens } from "@/lib/db/app-meta";
import { getDb, getSqlite } from "@/lib/db/client";
import {
  mailAssignments,
  mailConversations,
  mailEvents,
  mailMessages,
  mailUnassigned,
  trackerItems,
} from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import {
  TRIAGE_PROMPT_VERSION,
  triageConversations,
} from "../agents/conversation-triage";
import {
  EVENTS_PROMPT_VERSION,
  extractConversationEvents,
  type EventContext,
} from "../agents/event-extract";
import { SyncCanceledError, throwIfSyncCanceled } from "../cancel";
import { normalizeCompanyKey, parseEmailAddr } from "../identity";
import { softDeleteItemInTx } from "../item-tx";
import { askTrackerLlm, trackerModel } from "../llm";
import type { AiFeature } from "@/lib/ai-usage/features";
import type { LlmFn } from "../llm-core";
import { noteRecentItem } from "../recent";
import { normalizeMailText } from "../signals";
import type { SyncProgressFn } from "../types";
import {
  markRoutingSkipAsNoise,
  markUnassigned,
  writeAssignment,
} from "./assign";
import { syncConversations, type Conversation } from "./conversations";
import { normalizeMailEvent, type MailEvent } from "./events";
import {
  absorbConversation,
  addressesIn,
  nameSimilarity,
  resolveConversations,
  rolesFromList,
  type IdentityConversation,
  type IdentityItem,
  type IdentityRoles,
} from "./identity";
import { isNoiseMail, parseAutoFlags } from "./noise";
import {
  getCachedTriage,
  getLatestTriage,
  getTriageState,
  listSenderRoles,
  markEventsFailed,
  saveMailEvents,
  saveTriage,
  saveTriageFailure,
  type ConversationTranscript,
  type TriageResult,
} from "./stage-store";
import {
  buildTranscript,
  learnSignature,
  type SignatureModel,
} from "./transcript";

export type StageMode = "incremental" | "hard";

/** Per-run caps: the rest is picked up by the next sync. */
const MAX_TRIAGE_PER_RUN = 300;
const MAX_EVENTS_PER_RUN = 300;
const LLM_CONCURRENCY = 3;
/** Failed AI answers are retried on later syncs, at most this often (hard sync: always). */
const MAX_FAILED_ATTEMPTS = 5;
const FAILED_RETRY_MS = 10 * 60 * 1000;

type MailRow = typeof mailMessages.$inferSelect;

export type StageStats = {
  triaged: number;
  jobConversations: number;
  noiseConversations: number;
  triageFailed: number;
  attached: number;
  created: number;
  ambiguous: number;
  moved: number;
  eventsExtracted: number;
  eventsFailed: number;
  llmCalls: number;
  llmMs: number;
  /** Hard sync: live rows of the same employer (merge proposals, K3). */
  duplicatePairs: [number, number][];
};

function emptyStats(): StageStats {
  return {
    triaged: 0,
    jobConversations: 0,
    noiseConversations: 0,
    triageFailed: 0,
    attached: 0,
    created: 0,
    ambiguous: 0,
    moved: 0,
    eventsExtracted: 0,
    eventsFailed: 0,
    llmCalls: 0,
    llmMs: 0,
    duplicatePairs: [],
  };
}

function isOut(m: MailRow): boolean {
  return m.folder === "SENT" || m.direction === "out";
}

/** Header-only noise (mailing lists / bulk): structure, not meaning. */
function isHeaderNoise(m: Pick<MailRow, "autoFlags">): boolean {
  const flags = parseAutoFlags(m.autoFlags);
  return Boolean(flags && !flags.bounce && (flags.listId || flags.bulk));
}

function loadMails(ids: number[]): Map<number, MailRow> {
  const out = new Map<number, MailRow>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const m of getDb()
      .select()
      .from(mailMessages)
      .where(inArray(mailMessages.id, chunk))
      .all()) {
      out.set(m.id, m);
    }
  }
  return out;
}

function loadAssigned(): Map<number, { itemId: number; source: string; locked: boolean }> {
  const map = new Map<number, { itemId: number; source: string; locked: boolean }>();
  for (const r of getDb().select().from(mailAssignments).all()) {
    map.set(r.mailId, { itemId: r.itemId, source: r.source, locked: Boolean(r.locked) });
  }
  return map;
}

function convItem(
  conv: Conversation,
  assigned: Map<number, { itemId: number }>,
): number | null {
  const counts = new Map<number, number>();
  for (const id of conv.mailIds) {
    const a = assigned.get(id);
    if (a) counts.set(a.itemId, (counts.get(a.itemId) || 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
}

function retryDue(
  state: { attempts: number; createdAt: string } | null,
  force: boolean,
): boolean {
  if (!state || force) return true;
  if (state.attempts >= MAX_FAILED_ATTEMPTS) return false;
  return Date.now() - Date.parse(state.createdAt) >= FAILED_RETRY_MS;
}

class StageContext {
  readonly stats = emptyStats();
  readonly userEmails: string[];
  readonly accountId: string;
  /** Mail ids of this derive run — used so hard sync does not flood Recent. */
  readonly dirtyMailIds: Set<number>;
  private signature: SignatureModel | null = null;
  private readonly baseLlm: LlmFn | undefined;

  constructor(
    readonly mode: StageMode,
    userEmail: string,
    readonly log: SyncProgressFn | undefined,
    readonly signal: AbortSignal | undefined,
    dirtyMailIds: Set<number>,
    llm?: LlmFn,
  ) {
    this.accountId = getFencingTokens().accountId || userEmail;
    this.userEmails = [...new Set([userEmail, this.accountId].filter(Boolean))];
    this.dirtyMailIds = dirtyMailIds;
    this.baseLlm = llm;
  }

  /**
   * LLM function for one stage. The feature label is explicit per stage; hard
   * sync passes bypassCache so the response cache is skipped (the fresh answer
   * still replaces the cached one).
   */
  llmFor(feature: AiFeature, promptVersion?: number): LlmFn {
    const hard = this.mode === "hard";
    return async (prompt) => {
      throwIfSyncCanceled(this.signal);
      const t0 = Date.now();
      try {
        return this.baseLlm
          ? await this.baseLlm(prompt)
          : await askTrackerLlm(prompt, {
              feature,
              syncMode: this.mode,
              bypassCache: hard,
              promptVersion,
            });
      } finally {
        this.stats.llmCalls += 1;
        this.stats.llmMs += Date.now() - t0;
      }
    };
  }

  /** User's recurring signature, learned from recent SENT bodies. */
  sig(): SignatureModel {
    if (this.signature) return this.signature;
    const rows = getSqlite()
      .prepare(
        `SELECT body_text AS body FROM mail_messages
         WHERE (folder = 'SENT' OR direction = 'out')
           AND (labels_json IS NULL OR labels_json NOT LIKE '%Draft%'
                OR labels_json LIKE '%Sent%')
         ORDER BY COALESCE(internal_date, date_iso) DESC LIMIT 80`,
      )
      .all() as { body: string }[];
    this.signature = learnSignature(rows.map((r) => r.body || ""));
    return this.signature;
  }

  transcript(conv: Conversation, mails: Map<number, MailRow>): ConversationTranscript {
    return buildTranscript(
      { conversationId: conv.key, fingerprint: conv.fingerprint },
      conv.mailIds
        .map((id) => mails.get(id))
        .filter((m): m is MailRow => Boolean(m))
        .map((m) => ({
          id: m.id,
          dir: isOut(m) ? ("out" as const) : ("in" as const),
          at: m.internalDate || m.dateIso,
          from: m.fromAddr,
          to: m.toAddr,
          subject: m.subject,
          body: m.bodyText || m.snippet || "",
        })),
      { signature: this.sig(), userEmails: this.userEmails },
    );
  }

  roles(): IdentityRoles {
    return rolesFromList(listSenderRoles(this.accountId), this.userEmails);
  }

  checkpoint(): void {
    throwIfSyncCanceled(this.signal);
  }
}

/* ------------------------------------------------------------------ */
/* Stage 1                                                             */
/* ------------------------------------------------------------------ */

async function runTriage(
  ctx: StageContext,
  convs: Conversation[],
  mails: Map<number, MailRow>,
): Promise<Map<string, TriageResult | null>> {
  const out = new Map<string, TriageResult | null>();
  const todo: ConversationTranscript[] = [];
  const hard = ctx.mode === "hard";
  for (const conv of convs) {
    // Hard sync ignores a fresh cache so every conversation is re-read by AI
    // (same as a first-time sync). Incremental keeps the fingerprint cache.
    const cached = hard
      ? null
      : getCachedTriage(conv.key, conv.fingerprint, TRIAGE_PROMPT_VERSION);
    if (cached) {
      out.set(conv.key, cached);
      continue;
    }
    const state = getTriageState(conv.key);
    if (
      !hard &&
      state?.state === "failed" &&
      state.fingerprint === conv.fingerprint &&
      state.promptVersion === TRIAGE_PROMPT_VERSION &&
      !retryDue(state, false)
    ) {
      out.set(conv.key, null);
      continue;
    }
    todo.push(ctx.transcript(conv, mails));
  }
  if (!todo.length) return out;

  // Hard sync already announced the work above; skip the duplicate start line.
  if (ctx.mode !== "hard") {
    ctx.log?.("think", t("sync.stageTriageStart", { count: todo.length }));
  }
  let aiError: string | null = null;
  let triageDone = 0;
  const triageTotal = todo.length;
  const outcomes = await triageConversations(todo, {
    llm: ctx.llmFor("tracker.sync.triage", TRIAGE_PROMPT_VERSION),
    userEmails: ctx.userEmails,
    knownRoles: () => listSenderRoles(ctx.accountId),
    concurrency: LLM_CONCURRENCY,
    signal: ctx.signal,
    onResults: (results) => {
      // Persist as answers arrive so later batches see learned sender roles.
      ctx.checkpoint();
      for (const [id, r] of results) {
        const tr = todo.find((x) => x.conversationId === id)!;
        saveTriage(tr, r, {
          model: trackerModel("tracker.sync.triage"),
          promptVersion: TRIAGE_PROMPT_VERSION,
          accountId: ctx.accountId,
        });
      }
    },
    onCall: (info) => {
      triageDone += info.conversations;
      if (info.error) {
        aiError = info.error;
        ctx.log?.("system", t("sync.stageTriageBatchFailed", { msg: info.error }));
      } else {
        ctx.log?.(
          "ok",
          t("sync.stageTriageBatch", {
            done: triageDone,
            total: triageTotal,
            seconds: Math.round(info.ms / 1000),
          }),
        );
      }
    },
  });
  ctx.checkpoint();
  for (const tr of todo) {
    const o = outcomes.get(tr.conversationId);
    ctx.stats.triaged += 1;
    if (o?.ok) {
      out.set(tr.conversationId, o.result);
    } else {
      ctx.stats.triageFailed += 1;
      saveTriageFailure(tr, aiError || o?.error || "no answer", {
        model: trackerModel("tracker.sync.triage"),
        promptVersion: TRIAGE_PROMPT_VERSION,
      });
      out.set(tr.conversationId, null);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Stage 2                                                             */
/* ------------------------------------------------------------------ */

function identityConversation(
  conv: Conversation,
  triage: TriageResult,
  mails: Map<number, MailRow>,
  userEmails: string[],
): IdentityConversation {
  const own = new Set(userEmails.map((e) => e.toLowerCase()));
  const rows = conv.mailIds
    .map((id) => mails.get(id))
    .filter((m): m is MailRow => Boolean(m))
    .sort((a, b) => (a.internalDate || a.dateIso).localeCompare(b.internalDate || b.dateIso));
  const addresses = new Set<string>();
  for (const m of rows) {
    for (const a of addressesIn(`${m.fromAddr},${m.toAddr},${m.ccAddr}`)) {
      if (!own.has(a)) addresses.add(a);
    }
  }
  const firstIn = rows.find((m) => !isOut(m)) ?? rows[0];
  return {
    conversationId: conv.key,
    triage,
    addresses: [...addresses],
    subject: rows[0]?.subject || "",
    excerpt: normalizeMailText(firstIn?.bodyText || firstIn?.snippet || "").slice(0, 600),
  };
}

/** Live items with identity keys from their conversations' triage. */
function loadIdentityItems(
  convs: Conversation[],
  assigned: Map<number, { itemId: number }>,
  mails: Map<number, MailRow>,
  ctx: StageContext,
  roles: IdentityRoles,
  exclude?: Set<string>,
): IdentityItem[] {
  const items = new Map<number, IdentityItem>();
  for (const row of getDb().select().from(trackerItems).all()) {
    if (row.deletedAt) continue;
    const emails = [row.primaryTo, row.selectedRecipient]
      .map((e) => parseEmailAddr(e))
      .filter((e): e is string => Boolean(e));
    items.set(row.id, {
      id: row.id,
      company: row.company,
      position: row.position,
      channel: row.channel,
      employerNames: [],
      domains: [],
      emails: [],
      refCodes: [],
      lastSubject: null,
      lastEvent: row.lastIntent,
    });
    const item = items.get(row.id)!;
    for (const e of emails) {
      const d = e.split("@")[1] || "";
      if (d && !roles.nonEmployerDomains.has(d)) item.emails.push(e);
    }
  }
  const owned = convs.filter(
    (c) => !exclude?.has(c.key) && convItem(c, assigned) != null,
  );
  const missing = owned.flatMap((c) => c.mailIds).filter((id) => !mails.has(id));
  for (const [id, m] of loadMails(missing)) mails.set(id, m);
  for (const conv of owned) {
    const itemId = convItem(conv, assigned);
    const item = itemId != null ? items.get(itemId) : undefined;
    if (!item) continue;
    const triage = getLatestTriage(conv.key);
    if (!triage?.isJobProcess) continue;
    absorbConversation(item, identityConversation(conv, triage, mails, ctx.userEmails), roles);
  }
  return [...items.values()];
}

/** The intermediary as row channel — unless it is the employer itself. */
function channelOf(
  tri: TriageResult,
  company: string,
): { channel: string; channelKind: string | null } | null {
  const via = tri.intermediary?.trim();
  if (!via) return null;
  for (const name of [company, tri.employer]) {
    if (name && nameSimilarity(via, name) >= 0.5) return null;
  }
  return { channel: via.slice(0, 80), channelKind: tri.intermediaryKind };
}

function createItem(conv: IdentityConversation): number {
  const t0 = new Date().toISOString();
  const tri = conv.triage;
  const primaryTo =
    tri.counterpartEmail ||
    conv.addresses.find((a) => !/no-?reply|donotreply/.test(a)) ||
    conv.addresses[0] ||
    null;
  const inserted = getDb()
    .insert(trackerItems)
    .values({
      company: (tri.employer || "").slice(0, 120),
      position: tri.position,
      status: "in_progress",
      sentiment: null,
      waitingOn: null,
      followUpCount: 0,
      ignored: 0,
      primaryTo,
      notesJson: JSON.stringify({ notes: "derive create" }),
      userState: "active",
      aiStatus: null,
      channel: channelOf(tri, tri.employer || "")?.channel ?? null,
      channelKind: channelOf(tri, tri.employer || "")?.channelKind ?? null,
      updatedAt: t0,
      createdAt: t0,
    })
    .returning({ id: trackerItems.id })
    .get();
  if (!inserted) throw new Error(t("tracker.error.createItemFailed"));
  return inserted.id;
}

/** Assign every unlocked mail of the conversation to `itemId` (one tx). */
function attachConversation(
  conv: Conversation,
  itemId: number,
  mails: Map<number, MailRow>,
  triage: TriageResult | null,
  source: "identity" | "ai",
): number {
  const sqlite = getSqlite();
  let n = 0;
  sqlite.transaction(() => {
    for (const id of conv.mailIds) {
      const m = mails.get(id);
      if (!m) continue;
      writeAssignment({
        mailId: id,
        itemId,
        source,
        confidence: source === "ai" ? 0.8 : 0.9,
        mail: m,
      });
      n += 1;
    }
    getDb()
      .update(mailMessages)
      .set({ deriveState: "done" })
      .where(inArray(mailMessages.id, conv.mailIds))
      .run();
    getDb()
      .update(mailConversations)
      .set({ itemId })
      .where(eq(mailConversations.id, conv.key))
      .run();
    if (triage?.intermediary) {
      const item = getDb()
        .select({ channel: trackerItems.channel, company: trackerItems.company })
        .from(trackerItems)
        .where(eq(trackerItems.id, itemId))
        .get();
      const via = item && !item.channel ? channelOf(triage, item.company) : null;
      if (via) {
        getDb()
          .update(trackerItems)
          .set(via)
          .where(eq(trackerItems.id, itemId))
          .run();
      }
    }
  })();
  return n;
}

function itemCompany(itemId: number): string {
  return (
    getDb()
      .select({ company: trackerItems.company })
      .from(trackerItems)
      .where(eq(trackerItems.id, itemId))
      .get()?.company || `#${itemId}`
  );
}

async function runIdentity(
  ctx: StageContext,
  allConvs: Conversation[],
  targets: { conv: Conversation; triage: TriageResult }[],
  mails: Map<number, MailRow>,
  touched: Set<number>,
  exclude?: Set<string>,
): Promise<Map<string, number>> {
  const resolved = new Map<string, number>();
  if (!targets.length) return resolved;
  const roles = ctx.roles();
  const assigned = loadAssigned();
  const items = loadIdentityItems(allConvs, assigned, mails, ctx, roles, exclude);
  const ordered = [...targets].sort((a, b) =>
    (a.conv.latestAt || "").localeCompare(b.conv.latestAt || ""),
  );
  const idConvs = ordered.map((x) =>
    identityConversation(x.conv, x.triage, mails, ctx.userEmails),
  );
  const decisions = await resolveConversations(idConvs, items, roles, {
    llm: ctx.llmFor("tracker.sync.identity"),
    createItem: (c) => {
      ctx.checkpoint();
      return createItem(c);
    },
    onTieBreak: (info) => {
      ctx.log?.(
        info.error ? "system" : "ok",
        info.error
          ? t("sync.stageTieBreakFailed", { msg: info.error })
          : t("sync.stageTieBreak", { count: info.questions }),
      );
    },
  });
  ctx.checkpoint();

  for (const { conv, triage } of ordered) {
    const d = decisions.get(conv.key);
    if (d?.kind === "attach" || d?.kind === "create") {
      const itemId = d.kind === "attach" ? d.itemId : d.itemId!;
      attachConversation(conv, itemId, mails, triage, d.kind === "attach" && d.via !== "ai" ? "identity" : "ai");
      touched.add(itemId);
      resolved.set(conv.key, itemId);
      if (d.kind === "create") {
        ctx.stats.created += 1;
        noteRecentItem(itemId, "new_item", {
          detail: { source: "identity", mailCount: conv.mailIds.length },
        });
        ctx.log?.("ok", t("sync.incrementalCreated", { company: itemCompany(itemId) }));
      } else {
        ctx.stats.attached += 1;
        // Hard sync re-attaches everyone — only surface when dirty mail landed.
        const dirtyHit = conv.mailIds.some((id) => ctx.dirtyMailIds.has(id));
        if (ctx.mode !== "hard" || dirtyHit) {
          noteRecentItem(itemId, "mail_attached", {
            detail: { source: "identity", mailCount: conv.mailIds.length },
          });
        }
        ctx.log?.(
          "ok",
          t("sync.stageAttachedConversation", {
            count: conv.mailIds.length,
            company: itemCompany(itemId),
          }),
        );
      }
      continue;
    }
    ctx.stats.ambiguous += 1;
    for (const id of conv.mailIds) {
      if (!assigned.has(id)) markUnassigned(id, "ambiguous");
    }
    ctx.log?.(
      "system",
      t("sync.stageAmbiguous", {
        subject: (mails.get(conv.mailIds[0]!)?.subject || t("mail.noSubject")).slice(0, 60),
      }),
    );
  }
  return resolved;
}

function itemsOfConversation(
  conv: Conversation,
  assigned: Map<number, { itemId: number }>,
): Set<number> {
  const ids = new Set<number>();
  for (const id of conv.mailIds) {
    const a = assigned.get(id);
    if (a) ids.add(a.itemId);
  }
  return ids;
}

/**
 * Hard sync repairs on rows built by older pipelines (§2.6.7):
 * - a conversation split over several rows is re-resolved as a whole;
 * - conversations whose employer disagrees with their row's own employer
 *   (old domain / ATS / agency merges) are re-resolved.
 * Only unlocked, non-user assignments move. Rows emptied by a move with no
 * user traces are soft-deleted as orphans.
 */
async function verifyAssignedConversations(
  ctx: StageContext,
  allConvs: Conversation[],
  triage: Map<string, TriageResult | null>,
  mails: Map<number, MailRow>,
  touched: Set<number>,
): Promise<void> {
  const assigned = loadAssigned();
  const movable = (conv: Conversation) =>
    conv.mailIds.every((id) => {
      const a = assigned.get(id);
      return !a || (!a.locked && a.source !== "user");
    });
  const suspects = new Map<string, { conv: Conversation; triage: TriageResult; itemId: number }>();
  const byItem = new Map<number, { conv: Conversation; triage: TriageResult }[]>();
  for (const conv of allConvs) {
    const tr = triage.get(conv.key);
    const itemId = convItem(conv, assigned);
    if (!tr?.isJobProcess || itemId == null) continue;
    if (itemsOfConversation(conv, assigned).size > 1 && movable(conv)) {
      suspects.set(conv.key, { conv, triage: tr, itemId });
    }
    if (!tr.employer) continue;
    const list = byItem.get(itemId) || [];
    list.push({ conv, triage: tr });
    byItem.set(itemId, list);
  }
  for (const [itemId, list] of byItem) {
    const groups = new Map<string, { name: string; n: number }>();
    for (const x of list) {
      const k = normalizeCompanyKey(x.triage.employer);
      const g = groups.get(k) || { name: x.triage.employer!, n: 0 };
      g.n += x.conv.mailIds.length;
      groups.set(k, g);
    }
    if (groups.size < 2) continue;
    // The row's own employer is the group its name refers to; otherwise the
    // group with the most mail.
    const company = itemCompany(itemId);
    const ranked = [...groups.values()].sort((a, b) => b.n - a.n);
    const home =
      ranked.find((g) => nameSimilarity(g.name, company) >= 0.5) ?? ranked[0]!;
    for (const x of list) {
      if (nameSimilarity(x.triage.employer!, home.name) >= 0.5) continue;
      if (movable(x.conv)) suspects.set(x.conv.key, { ...x, itemId });
    }
  }
  if (!suspects.size) return;
  const list = [...suspects.values()];
  const exclude = new Set(suspects.keys());
  const before = new Set(list.map((s) => s.itemId));
  for (const s of list) for (const id of itemsOfConversation(s.conv, assigned)) before.add(id);
  const resolved = await runIdentity(ctx, allConvs, list, mails, touched, exclude);
  for (const s of list) {
    const to = resolved.get(s.conv.key);
    if (to != null && to !== s.itemId) {
      touched.add(s.itemId);
      ctx.stats.moved += 1;
      ctx.log?.(
        "system",
        t("sync.stageMoved", {
          employer: s.triage.employer || itemCompany(to),
          company: itemCompany(s.itemId),
        }),
      );
    }
  }
  for (const id of before) {
    touched.add(id);
    deleteIfOrphaned(id);
  }
}

function deleteIfOrphaned(itemId: number): void {
  const row = getDb().select().from(trackerItems).where(eq(trackerItems.id, itemId)).get();
  if (!row || row.deletedAt) return;
  const hasMail = getDb()
    .select({ id: mailAssignments.mailId })
    .from(mailAssignments)
    .where(eq(mailAssignments.itemId, itemId))
    .get();
  if (hasMail) return;
  const userTraces =
    row.userState === "inactive" ||
    Boolean(row.selectedRecipient) ||
    Boolean(row.workspaceFolder) ||
    Boolean(row.researchJobId);
  if (userTraces) return;
  softDeleteItemInTx(getSqlite(), itemId, "orphan", "sync");
}

/**
 * Live rows whose conversations name the same employer — duplicates from
 * older pipelines. Returned as merge-proposal pairs (K3: the user decides).
 */
function duplicateRowPairs(
  allConvs: Conversation[],
  triage: Map<string, TriageResult | null>,
): [number, number][] {
  const assigned = loadAssigned();
  const keysByItem = new Map<number, Set<string>>();
  for (const conv of allConvs) {
    const itemId = convItem(conv, assigned);
    if (itemId == null) continue;
    const tr = triage.get(conv.key) ?? getLatestTriage(conv.key);
    if (!tr?.isJobProcess || !tr.employer) continue;
    const k = normalizeCompanyKey(tr.employer);
    if (!k) continue;
    const set = keysByItem.get(itemId) || new Set<string>();
    set.add(k);
    keysByItem.set(itemId, set);
  }
  const entries = [...keysByItem.entries()].sort((a, b) => a[0] - b[0]);
  const pairs: [number, number][] = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [a, ka] = entries[i]!;
      const [b, kb] = entries[j]!;
      const alike = [...ka].some((x) => [...kb].some((y) => nameSimilarity(x, y) >= 0.6));
      if (alike) pairs.push([a, b]);
    }
  }
  return pairs;
}

/** Rows named after their intermediary (old ATS-named rows) take the employer name. */
function renameIntermediaryRows(
  allConvs: Conversation[],
  triage: Map<string, TriageResult | null>,
): void {
  const assigned = loadAssigned();
  const byItem = new Map<number, TriageResult[]>();
  for (const conv of allConvs) {
    const tr = triage.get(conv.key);
    const itemId = convItem(conv, assigned);
    if (!tr?.isJobProcess || itemId == null) continue;
    byItem.set(itemId, [...(byItem.get(itemId) || []), tr]);
  }
  for (const [itemId, list] of byItem) {
    const row = getDb().select().from(trackerItems).where(eq(trackerItems.id, itemId)).get();
    if (!row || row.deletedAt) continue;
    if (row.channel && nameSimilarity(row.channel, row.company) >= 0.5) {
      getDb()
        .update(trackerItems)
        .set({ channel: null, channelKind: null })
        .where(eq(trackerItems.id, itemId))
        .run();
    }
    const employers = new Set(list.map((x) => normalizeCompanyKey(x.employer)).filter(Boolean));
    const viaName = list.find(
      (x) =>
        x.intermediary &&
        normalizeCompanyKey(x.intermediary) === normalizeCompanyKey(row.company),
    );
    if (employers.size !== 1 || !viaName) continue;
    const employer = list.find((x) => x.employer)!.employer!;
    if (normalizeCompanyKey(employer) === normalizeCompanyKey(row.company)) continue;
    getDb()
      .update(trackerItems)
      .set({
        company: employer.slice(0, 120),
        channel: row.channel || viaName.intermediary,
        channelKind: row.channelKind || viaName.intermediaryKind,
      })
      .where(eq(trackerItems.id, itemId))
      .run();
  }
}

/* ------------------------------------------------------------------ */
/* Stage 3                                                             */
/* ------------------------------------------------------------------ */

function eventsStale(conv: Conversation, force: boolean): { stale: boolean; failed: boolean } {
  const row = getDb()
    .select()
    .from(mailConversations)
    .where(eq(mailConversations.id, conv.key))
    .get();
  if (!row) return { stale: true, failed: false };
  // Hard sync = first-sync semantics: re-run AI even when the cache is fresh.
  if (force) return { stale: true, failed: row.eventsState === "failed" };
  const sameKey =
    row.eventsFingerprint === conv.fingerprint &&
    row.eventsPromptVersion === EVENTS_PROMPT_VERSION;
  if (sameKey && row.eventsState === "ok") return { stale: false, failed: false };
  if (sameKey && row.eventsState === "failed") {
    const due =
      row.eventsAttempts < MAX_FAILED_ATTEMPTS &&
      Date.now() - Date.parse(row.eventsAt || "1970-01-01") >= FAILED_RETRY_MS;
    return { stale: due, failed: true };
  }
  return { stale: true, failed: false };
}

function eventContext(
  conv: Conversation,
  itemId: number,
  mails: Map<number, MailRow>,
): EventContext {
  const triage = getLatestTriage(conv.key);
  const itemMailIds = getDb()
    .select({ mailId: mailAssignments.mailId })
    .from(mailAssignments)
    .where(eq(mailAssignments.itemId, itemId))
    .all()
    .map((r) => r.mailId)
    .filter((id) => !conv.mailIds.includes(id));
  const lastAt = conv.latestAt;
  const others = loadMails(itemMailIds);
  const stored = new Map<number, MailEvent>();
  if (itemMailIds.length) {
    for (const r of getDb()
      .select()
      .from(mailEvents)
      .where(inArray(mailEvents.mailId, itemMailIds))
      .all()) {
      const e = normalizeMailEvent(r.event);
      if (e) stored.set(r.mailId, e);
    }
  }
  const item = getDb().select().from(trackerItems).where(eq(trackerItems.id, itemId)).get();
  void mails;
  return {
    employer: triage?.employer || item?.company || null,
    position: triage?.position || item?.position || null,
    otherActivity: [...others.values()]
      .map((m) => ({
        at: m.internalDate || m.dateIso,
        dir: isOut(m) ? ("out" as const) : ("in" as const),
        event: stored.get(m.id) ?? null,
        subject: m.subject,
      }))
      .filter((a) => a.at < lastAt)
      .sort((a, b) => a.at.localeCompare(b.at)),
  };
}

async function runEvents(
  ctx: StageContext,
  allConvs: Conversation[],
  mails: Map<number, MailRow>,
  touched: Set<number>,
  scopeItems: Set<number> | null,
): Promise<void> {
  const assigned = loadAssigned();
  const jobs: { conv: Conversation; itemId: number }[] = [];
  let capped = 0;
  for (const conv of allConvs) {
    const itemId = convItem(conv, assigned);
    if (itemId == null) continue;
    const st = eventsStale(conv, ctx.mode === "hard");
    if (!st.stale) continue;
    if (scopeItems && !scopeItems.has(itemId) && !st.failed) continue;
    if (jobs.length >= MAX_EVENTS_PER_RUN) {
      capped += 1;
      continue;
    }
    jobs.push({ conv, itemId });
  }
  if (capped) ctx.log?.("system", t("sync.stageCapped", { count: capped }));
  if (!jobs.length) return;

  const need = loadMails(jobs.flatMap((j) => j.conv.mailIds).filter((id) => !mails.has(id)));
  for (const [id, m] of need) mails.set(id, m);

  ctx.log?.("think", t("sync.stageEventsStart", { count: jobs.length }));
  const prepared = jobs.map((j) => ({
    transcript: ctx.transcript(j.conv, mails),
    context: eventContext(j.conv, j.itemId, mails),
  }));
  let eventsDone = 0;
  const eventsTotal = jobs.length;
  const outcomes = await extractConversationEvents(prepared, {
    llm: ctx.llmFor("tracker.sync.events", EVENTS_PROMPT_VERSION),
    userEmails: ctx.userEmails,
    concurrency: LLM_CONCURRENCY,
    signal: ctx.signal,
    onCall: (info) => {
      eventsDone += info.conversations;
      ctx.log?.(
        info.error ? "system" : "ok",
        info.error
          ? t("sync.stageEventsBatchFailed", { msg: info.error })
          : t("sync.stageEventsBatch", {
              done: eventsDone,
              total: eventsTotal,
              seconds: Math.round(info.ms / 1000),
            }),
      );
    },
  });
  ctx.checkpoint();
  let failed = 0;
  for (const j of jobs) {
    const o = outcomes.get(j.conv.key);
    touched.add(j.itemId);
    if (o?.ok) {
      saveMailEvents(j.conv.key, o.events, {
        source: "ai",
        model: trackerModel("tracker.sync.events"),
        promptVersion: EVENTS_PROMPT_VERSION,
        fingerprint: j.conv.fingerprint,
      });
      ctx.stats.eventsExtracted += 1;
    } else {
      markEventsFailed(j.conv.key, {
        fingerprint: j.conv.fingerprint,
        promptVersion: EVENTS_PROMPT_VERSION,
      });
      failed += 1;
    }
  }
  ctx.stats.eventsFailed += failed;
  if (failed) ctx.log?.("system", t("sync.stageEventsFailed", { count: failed }));
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Stages 1–3 after stage 0. `dirtyMailIds` = mails of this derive run;
 * incremental mode only looks at their conversations (plus due retries);
 * hard mode re-runs every conversation through AI (cache ignored), like a
 * first sync — existing rows are kept and re-attached, not wiped.
 */
export async function runConversationStages(opts: {
  mode: StageMode;
  dirtyMailIds: Set<number>;
  touched: Set<number>;
  userEmail: string;
  onProgress?: SyncProgressFn;
  signal?: AbortSignal;
  llm?: LlmFn;
}): Promise<StageStats> {
  const ctx = new StageContext(
    opts.mode,
    opts.userEmail,
    opts.onProgress,
    opts.signal,
    opts.dirtyMailIds,
    opts.llm,
  );
  const hard = opts.mode === "hard";
  const convs = syncConversations();
  let assigned = loadAssigned();
  const retryUnassigned = new Set(
    getDb()
      .select()
      .from(mailUnassigned)
      .all()
      .filter((r) => r.reason !== "ambiguous" || hard)
      .map((r) => r.mailId),
  );

  // Conversations to triage: unassigned ones touched by this run / due for
  // retry; hard sync re-analyses every conversation (AI cache ignored).
  const triageSet: Conversation[] = [];
  let capped = 0;
  // The cap bounds AI work; incremental cached answers are free, hard is not.
  let needsAi = 0;
  const relevant = convs.filter((c) => {
    if (hard) return true;
    if (convItem(c, assigned) != null) return false;
    return c.mailIds.some((id) => opts.dirtyMailIds.has(id) || retryUnassigned.has(id));
  });
  // Header flags only (bodies are loaded for the conversations we analyse).
  const flagsById = new Map(
    (
      getSqlite()
        .prepare(`SELECT id, auto_flags AS autoFlags, derive_state AS deriveState FROM mail_messages`)
        .all() as { id: number; autoFlags: string | null; deriveState: string }[]
    ).map((r) => [r.id, r]),
  );
  const sorted = [...relevant].sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  for (const conv of sorted) {
    const rows = conv.mailIds.map((id) => flagsById.get(id)).filter(Boolean) as {
      id: number;
      autoFlags: string | null;
      deriveState: string;
    }[];
    if (!rows.length) continue;
    if (rows.every(isHeaderNoise)) {
      if (convItem(conv, assigned) == null) {
        for (const r of rows) if (r.deriveState !== "noise") markRoutingSkipAsNoise(r.id);
      }
      continue;
    }
    const cached = hard
      ? null
      : getCachedTriage(conv.key, conv.fingerprint, TRIAGE_PROMPT_VERSION);
    if (!cached && needsAi >= MAX_TRIAGE_PER_RUN) {
      capped += 1;
      // Unowned mail stays in the derive queue for the next run.
      if (convItem(conv, assigned) == null) {
        const ids = rows.filter((r) => r.deriveState !== "noise").map((r) => r.id);
        if (ids.length) {
          getDb()
            .update(mailMessages)
            .set({ deriveState: "pending" })
            .where(inArray(mailMessages.id, ids))
            .run();
        }
      }
      continue;
    }
    if (!cached) needsAi += 1;
    triageSet.push(conv);
  }
  // One clear line for hard sync (count being worked + deferred), instead of
  // "375 / 22 next / Reading 300" which reads as contradictory.
  if (hard && triageSet.length) {
    ctx.log?.(
      "think",
      capped
        ? t("sync.hardAiReanalyzePartial", {
            count: triageSet.length,
            deferred: capped,
          })
        : t("sync.hardAiReanalyze", { count: triageSet.length }),
    );
  } else if (capped) {
    ctx.log?.("system", t("sync.stageCapped", { count: capped }));
  }
  const meta = loadMails(triageSet.flatMap((c) => c.mailIds));

  let triage = new Map<string, TriageResult | null>();
  try {
    triage = await runTriage(ctx, triageSet, meta);
  } catch (err) {
    if (err instanceof SyncCanceledError) throw err;
    ctx.log?.(
      "system",
      t("sync.stageAiUnavailable", {
        count: triageSet.length,
        msg: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  ctx.checkpoint();

  assigned = loadAssigned();
  const unassignedJob: { conv: Conversation; triage: TriageResult }[] = [];
  let degraded = 0;
  for (const conv of triageSet) {
    if (convItem(conv, assigned) != null) continue;
    const tr = triage.get(conv.key) ?? null;
    if (!tr) {
      // AI unavailable / no valid answer: header + regex fallback decides
      // only "noise"; everything else waits visibly (no guessed rows).
      degraded += 1;
      for (const id of conv.mailIds) {
        const m = meta.get(id);
        if (!m) continue;
        const noise = isNoiseMail({
          subject: m.subject,
          fromAddr: m.fromAddr,
          toAddr: m.toAddr,
          snippet: m.snippet,
          bodyPreview: normalizeMailText(m.bodyText || "").slice(0, 600),
          autoFlags: parseAutoFlags(m.autoFlags),
        });
        if (noise) markRoutingSkipAsNoise(id);
        else markUnassigned(id, "ai_unavailable");
      }
      continue;
    }
    if (!tr.isJobProcess) {
      ctx.stats.noiseConversations += 1;
      for (const id of conv.mailIds) markRoutingSkipAsNoise(id);
      continue;
    }
    ctx.stats.jobConversations += 1;
    unassignedJob.push({ conv, triage: tr });
  }
  if (degraded) {
    ctx.log?.("system", t("sync.stageTriageDegraded", { count: degraded }));
  }

  if (unassignedJob.length) {
    await runIdentity(ctx, convs, unassignedJob, meta, opts.touched);
  }
  if (hard) {
    await verifyAssignedConversations(ctx, convs, triage, meta, opts.touched);
    renameIntermediaryRows(convs, triage);
  }
  if (hard || ctx.stats.created > 0) {
    ctx.stats.duplicatePairs = duplicateRowPairs(syncConversations(), triage);
  }
  ctx.checkpoint();

  // Conversation item ids changed above; events need the fresh mapping.
  await runEvents(ctx, syncConversations(), meta, opts.touched, hard ? null : new Set(opts.touched));

  ctx.log?.(
    "ok",
    t("sync.stageSummary", {
      job: ctx.stats.jobConversations,
      noise: ctx.stats.noiseConversations,
      unverified: ctx.stats.triageFailed + ctx.stats.eventsFailed,
      calls: ctx.stats.llmCalls,
      seconds: Math.round(ctx.stats.llmMs / 1000),
    }),
  );
  return ctx.stats;
}
