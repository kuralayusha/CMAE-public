import { t } from "@/lib/i18n/t";
import { SyncCanceledError, throwIfSyncCanceled } from "./cancel";
import { consolidateAiGroups } from "./consolidate";
import { askTrackerLlm, extractJson } from "./llm";
import {
  intentOf,
  isAckish,
  type MailIntentMap,
} from "./mail-kind";
import {
  companyKey,
  detectAckOnly,
  detectAutoAck,
  detectClickAction,
  detectOooAway,
  isNonJobMail,
  parseReturnDate,
} from "./signals";
import type {
  SyncProgressFn,
  TrackerSentiment,
  TrackerStatus,
  WaitingOn,
} from "./types";
import type { WorkspaceCandidate } from "./workspace-merge";

export type MailBrief = {
  id: number;
  folder: string;
  fromAddr: string;
  toAddr: string;
  subject: string;
  dateIso: string;
  snippet: string;
  threadId: string | null;
  /** Truncated body for AI / signal detection */
  bodyPreview: string;
};

export type AiGroup = {
  company: string;
  position: string | null;
  status: TrackerStatus;
  sentiment: TrackerSentiment | null;
  waitingOn: WaitingOn | null;
  waitingUntil: string | null;
  isThanksSent: boolean;
  isAutoReply: boolean;
  isAckOnly: boolean;
  isClickAction: boolean;
  followUpCountHint: number;
  mailIds: number[];
  researchJobId: string | null;
  notes: string;
};

type AiResponse = {
  groups: Array<{
    company: string;
    position?: string | null;
    status?: string;
    sentiment?: string | null;
    waitingOn?: string | null;
    waitingUntil?: string | null;
    isThanksSent?: boolean;
    isAutoReply?: boolean;
    isAckOnly?: boolean;
    isClickAction?: boolean;
    followUpCountHint?: number;
    mailIds: number[];
    researchJobId?: string | null;
    notes?: string;
  }>;
};

const ALLOWED: TrackerStatus[] = [
  "ready_to_send",
  "needs_reply",
  "needs_action",
  "follow_up_due",
  "waiting",
  "in_progress",
  "rejected",
  "closed",
  "inactive",
  "ignored",
];

function normalizeStatus(v: string | undefined): TrackerStatus {
  // inactive is user/API-only — AI must not invent it
  if (v === "inactive") return "in_progress";
  if (v && ALLOWED.includes(v as TrackerStatus)) return v as TrackerStatus;
  return "in_progress";
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function heuristicGroups(
  mails: MailBrief[],
  searches: WorkspaceCandidate[],
): AiGroup[] {
  const byDomain = new Map<string, MailBrief[]>();
  for (const m of mails) {
    const addr =
      (m.folder === "SENT" ? m.toAddr : m.fromAddr).split(",")[0]?.trim() ||
      "";
    const domain = addr.split("@")[1]?.toLowerCase() || "unknown";
    const list = byDomain.get(domain) || [];
    list.push(m);
    byDomain.set(domain, list);
  }

  const groups: AiGroup[] = [];
  for (const [domain, list] of byDomain) {
    const sorted = [...list].sort((a, b) => a.dateIso.localeCompare(b.dateIso));
    const last = sorted.at(-1);
    const lastIn = [...sorted].filter((m) => m.folder === "INBOX").at(-1);
    const hasOut = list.some((m) => m.folder === "SENT");
    const hasIn = list.some((m) => m.folder === "INBOX");

    let status: TrackerStatus = "in_progress";
    let waitingUntil: string | null = null;
    let isAutoReply = false;
    let isAckOnly = false;
    let isClickAction = false;

    if (lastIn) {
      const blob = `${lastIn.subject}\n${lastIn.bodyPreview || lastIn.snippet}`;
      const sentAfter =
        Boolean(last) &&
        last!.folder === "SENT" &&
        Date.parse(last!.dateIso) > Date.parse(lastIn.dateIso);
      if (detectOooAway(lastIn.subject, blob) && !sentAfter) {
        isAutoReply = true;
        status = "waiting";
        waitingUntil = parseReturnDate(blob);
      } else if (
        detectAutoAck(lastIn.subject, blob) ||
        detectAckOnly(lastIn.subject, blob, lastIn.fromAddr)
      ) {
        isAutoReply = detectAutoAck(lastIn.subject, blob);
        isAckOnly = true;
        status = sentAfter || hasOut ? "follow_up_due" : "in_progress";
      } else if (
        detectClickAction(lastIn.subject, blob, lastIn.fromAddr) &&
        !sentAfter
      ) {
        isClickAction = true;
        status = "needs_action";
      } else if (hasIn && hasOut) {
        status = last?.folder === "INBOX" ? "needs_reply" : "in_progress";
      } else if (hasOut && !hasIn) {
        status = "follow_up_due";
      } else if (hasIn && !hasOut) {
        status = "needs_reply";
      }
    } else if (hasOut) {
      status = "follow_up_due";
    }

    groups.push({
      company: domain.split(".")[0] || domain,
      position: null,
      status,
      sentiment: status === "needs_reply" ? "neutral" : null,
      waitingOn:
        status === "needs_reply" || status === "needs_action" ? "us" : "them",
      waitingUntil,
      isThanksSent: false,
      isAutoReply,
      isAckOnly,
      isClickAction,
      followUpCountHint: 0,
      mailIds: list.map((m) => m.id),
      researchJobId: null,
      notes: "heuristic fallback",
    });
  }

  for (const s of searches) {
    const already = groups.some(
      (g) =>
        g.researchJobId === s.researchJobId ||
        companyKey(g.company) === companyKey(s.company),
    );
    if (already) continue;
    groups.push({
      company: s.company,
      position: null,
      status: "ready_to_send",
      sentiment: null,
      waitingOn: null,
      waitingUntil: null,
      isThanksSent: false,
      isAutoReply: false,
      isAckOnly: false,
      isClickAction: false,
      followUpCountHint: 0,
      mailIds: [],
      researchJobId: s.researchJobId,
      notes: "workspace search only",
    });
  }

  return consolidateAiGroups(groups, mails);
}

async function matchBatch(
  mails: MailBrief[],
  searches: WorkspaceCandidate[],
  mailIntents?: MailIntentMap,
): Promise<AiGroup[] | null> {
  // The multilingual intent examples in the prompt (DE/TR/FR) are intentional:
  // they show the model that intents are language-independent.
  const prompt = `You classify job-application Gmail for a cold-mail tracker.

LANGUAGE: Work in ANY language. Judge meaning, not keywords. Examples of the SAME intents:
- ACK receipt: DE "Vielen Dank für Ihre Bewerbung" / EN "Thanks for applying" / TR "Başvurunuz alınmıştır" / FR "Nous avons bien reçu votre candidature"
- Auto-ACK bot: automated "we will contact you" with no human content
- OOO: person away until a date (vacation), not application receipt
- Rejection: soft/hard decline in any language
- needs_reply: they ask a real written question
- needs_action: required click/verify/consent button (not optional portal)

CRITICAL GROUPING:
- ONE row per company application process. Merge related mails across people/threads.
- Same company + different job openings → separate groups.
- NEVER split SENT vs INBOX of the same conversation.
- Merge auto-replies/ACKs into the application group — never a standalone needs_reply row.
- OMIT: personal chatter, newsletters, non-job threads (intent=non_job).

STATUS RULES:
ready_to_send — workspace draft only, no outbound yet
needs_reply — THEY asked a REAL WRITTEN question (any language). Sentiment required.
needs_action — REQUIRED click/button only. isClickAction=true. NOT optional "view status" portals.
waiting — ONLY real OOO/vacation with optional waitingUntil YYYY-MM-DD. isAutoReply=true.
  NEVER waiting for generic application receipts / auto-ACK.
in_progress — within follow-up window; ball with them; includes fresh ACK.
follow_up_due — ball with THEM and silence past follow-up window since last outbound OR since thank-you/ACK with no later human_reply. Auto-ACK must NOT keep the row in in_progress forever.
rejected — rejection, thanks not sent
closed — done / thanks sent
ignored — ghosted after follow-ups

FLAGS (align with MAIL_INTENT hints when present):
isAckOnly=true for ack/auto_ack/optional_portal
isAutoReply=true for auto_ack/ooo
isClickAction=true for click_action

Return ONLY JSON:
{
  "groups": [
    {
      "company": "ACME",
      "position": "Frontend Developer" | null,
      "status": "waiting",
      "sentiment": "positive" | "negative" | "neutral" | null,
      "waitingOn": "us" | "them" | null,
      "waitingUntil": "2026-10-16" | null,
      "isThanksSent": false,
      "isAutoReply": true,
      "isAckOnly": false,
      "isClickAction": false,
      "followUpCountHint": 0,
      "mailIds": [1,2,3],
      "researchJobId": "uuid-or-null",
      "notes": "short reason"
    }
  ]
}

MAILS (intent = prior language-agnostic label; trust unless clearly wrong):
${JSON.stringify(
  mails.map((m) => ({
    id: m.id,
    folder: m.folder,
    fromAddr: m.fromAddr,
    toAddr: m.toAddr,
    subject: m.subject,
    dateIso: m.dateIso,
    threadId: m.threadId,
    snippet: m.snippet,
    bodyPreview: m.bodyPreview.slice(0, 400),
    intent: mailIntents ? intentOf(mailIntents, m.id) : undefined,
  })),
  null,
  2,
)}

SEARCH_CANDIDATES:
${JSON.stringify(
  searches.map((s) => ({
    researchJobId: s.researchJobId,
    company: s.company,
    url: s.url,
    hasEmailDraft: s.hasEmailDraft,
  })),
  null,
  2,
)}
`;

  const text = await askTrackerLlm(prompt, { feature: "tracker.match" });
  const parsed = extractJson<AiResponse>(text);
  if (!parsed?.groups || !Array.isArray(parsed.groups)) return null;

  return parsed.groups
    .filter((g) => g.company && Array.isArray(g.mailIds))
    .map((g) => {
      const mailIds = g.mailIds.map(Number).filter((n) => Number.isFinite(n));
      // Boost flags from prior intent pass (any language)
      let isAckOnly = Boolean(g.isAckOnly);
      let isAutoReply = Boolean(g.isAutoReply);
      let isClickAction = Boolean(g.isClickAction);
      if (mailIntents) {
        for (const id of mailIds) {
          const intent = intentOf(mailIntents, id);
          if (isAckish(intent)) isAckOnly = true;
          if (intent === "auto_ack" || intent === "ooo") isAutoReply = true;
          if (intent === "click_action") isClickAction = true;
        }
      }
      return {
        company: String(g.company).trim(),
        position: g.position ? String(g.position).trim() : null,
        status: normalizeStatus(g.status),
        sentiment:
          g.sentiment === "positive" ||
          g.sentiment === "negative" ||
          g.sentiment === "neutral"
            ? g.sentiment
            : null,
        waitingOn:
          g.waitingOn === "us" || g.waitingOn === "them" ? g.waitingOn : null,
        waitingUntil: g.waitingUntil
          ? String(g.waitingUntil).slice(0, 10)
          : null,
        isThanksSent: Boolean(g.isThanksSent),
        isAutoReply,
        isAckOnly,
        isClickAction,
        followUpCountHint: Number(g.followUpCountHint) || 0,
        mailIds,
        researchJobId: g.researchJobId ? String(g.researchJobId) : null,
        notes: g.notes ? String(g.notes) : "",
      };
    });
}

export async function matchMailsToGroups(
  mails: MailBrief[],
  searches: WorkspaceCandidate[],
  opts?: {
    onProgress?: SyncProgressFn;
    signal?: AbortSignal;
    mailIntents?: MailIntentMap;
  },
): Promise<AiGroup[]> {
  const log = opts?.onProgress;
  const signal = opts?.signal;
  const mailIntents = opts?.mailIntents;
  if (!mails.length && !searches.length) return [];

  const jobMails = mails.filter((m) => {
    if (mailIntents && intentOf(mailIntents, m.id) === "non_job") return false;
    return !isNonJobMail(m);
  });
  const dropped = mails.length - jobMails.length;
  if (dropped > 0) {
    log?.(
      "system",
      t("sync.droppedNoise", { count: dropped }),
    );
  }

  try {
    throwIfSyncCanceled(signal);
    if (jobMails.length <= 80) {
      log?.(
        "think",
        t("sync.aiGroupingSingle", { count: jobMails.length }),
      );
      const one = await matchBatch(jobMails, searches, mailIntents);
      throwIfSyncCanceled(signal);
      if (one) {
        const merged = consolidateAiGroups(
          mergeMissingSearches(one, searches),
          jobMails,
        );
        log?.(
          "ok",
          t("sync.aiConsolidate", {
            groups: one.length,
            rows: merged.length,
          }),
        );
        return merged;
      }
      log?.("system", t("sync.aiParseFailed"));
    } else if (jobMails.length > 0) {
      const batches = chunk(jobMails, 50);
      const all: AiGroup[] = [];
      for (let i = 0; i < batches.length; i++) {
        throwIfSyncCanceled(signal);
        const batch = batches[i]!;
        log?.(
          "think",
          t("sync.aiGroupingBatch", {
            n: i + 1,
            total: batches.length,
            count: batch.length,
          }),
        );
        const part = await matchBatch(batch, searches, mailIntents);
        if (part) {
          all.push(...part);
          log?.(
            "ok",
            t("sync.batchOk", { n: i + 1, groups: part.length }),
          );
        } else {
          // Never drop mails silently — fall this batch to heuristic grouping.
          log?.("system", t("sync.batchParseFailed", { n: i + 1 }));
          const heuristicPart = heuristicGroups(batch, []);
          all.push(...heuristicPart);
        }
      }
      if (all.length) {
        const merged = consolidateAiGroups(
          mergeMissingSearches(all, searches),
          jobMails,
        );
        log?.(
          "ok",
          t("sync.consolidateRows", { rows: merged.length }),
        );
        return merged;
      }
    }
  } catch (err) {
    if (err instanceof SyncCanceledError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    log?.("err", t("sync.aiMatchFailed", { msg }));
    console.warn("[tracker/match] AI match failed, using heuristic:", err);
  }

  throwIfSyncCanceled(signal);
  log?.("system", t("sync.heuristicGrouping"));
  return heuristicGroups(jobMails, searches);
}

function emptyReadyGroup(
  s: WorkspaceCandidate,
  notes: string,
): AiGroup {
  return {
    company: s.company,
    position: null,
    status: "ready_to_send",
    sentiment: null,
    waitingOn: null,
    waitingUntil: null,
    isThanksSent: false,
    isAutoReply: false,
    isAckOnly: false,
    isClickAction: false,
    followUpCountHint: 0,
    mailIds: [],
    researchJobId: s.researchJobId,
    notes,
  };
}

/**
 * Attach workspace searches. If a NEW search has an email draft but the
 * company already has prior outbound mail threads, keep a separate
 * ready_to_send row so the fresh draft is not swallowed by follow_up_due.
 */
function mergeMissingSearches(
  groups: AiGroup[],
  searches: WorkspaceCandidate[],
): AiGroup[] {
  const out = [...groups];
  const newestFirst = [...searches].sort((a, b) => b.createdAt - a.createdAt);
  const readyCompanyAdded = new Set<string>();

  for (const s of newestFirst) {
    const ck = companyKey(s.company);
    const exact = out.some((g) => g.researchJobId === s.researchJobId);
    if (exact) continue;

    const sameCompany = out.filter((g) => companyKey(g.company) === ck);
    const companyHasMails = sameCompany.some((g) => g.mailIds.length > 0);
    const companyHasOutboundThread = sameCompany.some(
      (g) =>
        g.mailIds.length > 0 &&
        g.status !== "ready_to_send" &&
        g.status !== "closed",
    );

    // Fresh search draft + existing correspondence → separate ready_to_send
    if (s.hasEmailDraft && companyHasOutboundThread) {
      if (readyCompanyAdded.has(ck)) {
        // Still point the mail thread at the newest folder for browsing
        for (const g of sameCompany) {
          if (!g.researchJobId) g.researchJobId = s.researchJobId;
        }
        continue;
      }
      readyCompanyAdded.add(ck);
      out.push(
        emptyReadyGroup(
          s,
          "workspace search draft — prior mail thread tracked separately",
        ),
      );
      // Link newest search onto an existing mail group for folder access
      for (const g of sameCompany) {
        if (g.mailIds.length > 0) g.researchJobId = s.researchJobId;
      }
      continue;
    }

    if (companyHasMails) {
      for (const g of sameCompany) {
        if (!g.researchJobId) g.researchJobId = s.researchJobId;
      }
      continue;
    }

    if (readyCompanyAdded.has(ck)) continue;
    readyCompanyAdded.add(ck);
    out.push(emptyReadyGroup(s, "workspace search only"));
  }
  return out;
}
