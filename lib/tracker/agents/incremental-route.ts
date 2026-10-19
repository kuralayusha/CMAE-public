/**
 * AI pass for quick sync: is this mail job-related, and which existing
 * application row should it join (or create a new one)?
 */

import { t } from "@/lib/i18n/t";
import { SyncCanceledError, throwIfSyncCanceled } from "../cancel";
import { askTrackerLlm, extractJson } from "../llm";
import type { MailBrief } from "../match";
import type { SyncProgressFn } from "../types";

export type ExistingItemBrief = {
  id: number;
  company: string;
  position: string | null;
  status: string;
  primaryTo: string | null;
  lastSubject?: string | null;
};

export type IncrementalRouteAction = "skip" | "attach" | "create";

export type IncrementalRouteDecision = {
  mailId: number;
  action: IncrementalRouteAction;
  itemId: number | null;
  company: string | null;
  position: string | null;
  reason?: string;
};

type AiRouteResponse = {
  decisions?: Array<{
    mailId?: number | string;
    action?: string;
    itemId?: number | string | null;
    company?: string | null;
    position?: string | null;
    reason?: string;
  }>;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildPrompt(
  mails: MailBrief[],
  items: ExistingItemBrief[],
): string {
  return `You route NEW inbound emails for a job-application tracker (quick sync).

LANGUAGE: Judge meaning in ANY language. Do NOT rely on fixed keywords.

For EACH mail pick exactly ONE action:
- skip — NOT a job-application thread. Examples: account security alerts (Google, Apple, banks), tutoring/marketplace platforms (Preply, etc.), shopping, social, newsletters, personal chatter, OTP codes, shipping, subscriptions. When unsure and there is NO clear hiring/recruiting/application signal → skip.
- attach — clearly about an existing application listed in EXISTING_ITEMS (same company/process, recruiting reply, interview, ACK, rejection for that role). Set itemId to that row's id.
- create — clearly a NEW job application / recruiting outreach that does NOT belong to any EXISTING_ITEMS row. Set company (required) and position when known.

RULES:
- Prefer skip over create when the sender is a consumer product (Google account alerts, Preply lessons, Netflix, banks, …) unless the body is explicitly about a job application / recruiting / interview for a role.
- Prefer attach over create when company/domain/contact matches an existing item.
- Never invent itemId values that are not in EXISTING_ITEMS.
- Never attach non-job noise to an existing item.

Return ONLY JSON:
{"decisions":[{"mailId":1,"action":"skip","itemId":null,"company":null,"position":null,"reason":"short"}]}

EXISTING_ITEMS:
${JSON.stringify(items, null, 2)}

NEW_MAILS:
${JSON.stringify(
  mails.map((m) => ({
    id: m.id,
    fromAddr: m.fromAddr,
    toAddr: m.toAddr,
    subject: m.subject,
    dateIso: m.dateIso,
    snippet: m.snippet,
    bodyPreview: (m.bodyPreview || "").slice(0, 500),
  })),
  null,
  2,
)}
`;
}

function normalizeDecision(
  raw: NonNullable<AiRouteResponse["decisions"]>[number],
  validItemIds: Set<number>,
): IncrementalRouteDecision | null {
  const mailId = Number(raw.mailId);
  if (!Number.isFinite(mailId)) return null;

  const actionRaw = String(raw.action || "").toLowerCase();
  let action: IncrementalRouteAction = "skip";
  if (actionRaw === "attach" || actionRaw === "create" || actionRaw === "skip") {
    action = actionRaw;
  }

  let itemId =
    raw.itemId == null || String(raw.itemId).trim() === ""
      ? null
      : Number(raw.itemId);
  if (itemId != null && !Number.isFinite(itemId)) itemId = null;
  if (itemId != null && !validItemIds.has(itemId)) itemId = null;

  let company = raw.company ? String(raw.company).trim() : null;
  let position = raw.position ? String(raw.position).trim() : null;
  if (position === "") position = null;

  if (action === "attach" && itemId == null) {
    action = "skip";
  }
  if (action === "create") {
    if (!company) {
      action = "skip";
    }
    itemId = null;
  }
  if (action === "skip") {
    itemId = null;
    company = null;
    position = null;
  }

  return {
    mailId,
    action,
    itemId,
    company,
    position,
    reason: raw.reason ? String(raw.reason).slice(0, 200) : undefined,
  };
}

async function routeBatch(
  mails: MailBrief[],
  items: ExistingItemBrief[],
): Promise<IncrementalRouteDecision[]> {
  const text = await askTrackerLlm(buildPrompt(mails, items));
  const parsed = extractJson<AiRouteResponse>(text);
  if (!parsed?.decisions || !Array.isArray(parsed.decisions)) return [];

  const validItemIds = new Set(items.map((i) => i.id));
  const out: IncrementalRouteDecision[] = [];
  for (const row of parsed.decisions) {
    const d = normalizeDecision(row, validItemIds);
    if (d) out.push(d);
  }
  return out;
}

/**
 * Ask AI whether each new mail is job-related and where it belongs.
 * Missing decisions default to skip (safe for quick sync).
 */
export async function routeIncrementalMails(
  mails: MailBrief[],
  items: ExistingItemBrief[],
  opts?: { onProgress?: SyncProgressFn; signal?: AbortSignal },
): Promise<Map<number, IncrementalRouteDecision>> {
  const log = opts?.onProgress;
  const signal = opts?.signal;
  const map = new Map<number, IncrementalRouteDecision>();
  if (!mails.length) return map;

  const batches = chunk(mails, 25);
  log?.(
    "think",
    t("sync.incrementalRouteStart", {
      count: mails.length,
      batches: batches.length,
    }),
  );

  for (let i = 0; i < batches.length; i++) {
    throwIfSyncCanceled(signal);
    const batch = batches[i]!;
    try {
      const rows = await routeBatch(batch, items);
      for (const row of rows) map.set(row.mailId, row);
      log?.(
        "ok",
        t("sync.incrementalRouteBatchOk", {
          n: i + 1,
          total: batches.length,
          labels: rows.length,
        }),
      );
    } catch (err) {
      if (err instanceof SyncCanceledError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      log?.(
        "system",
        t("sync.incrementalRouteBatchFailed", { n: i + 1, msg }),
      );
    }
  }

  for (const m of mails) {
    if (!map.has(m.id)) {
      map.set(m.id, {
        mailId: m.id,
        action: "skip",
        itemId: null,
        company: null,
        position: null,
        reason: "no AI decision",
      });
    }
  }

  const skips = [...map.values()].filter((d) => d.action === "skip").length;
  const attaches = [...map.values()].filter((d) => d.action === "attach").length;
  const creates = [...map.values()].filter((d) => d.action === "create").length;
  log?.(
    "ok",
    t("sync.incrementalRouteSummary", {
      skip: skips,
      attach: attaches,
      create: creates,
    }),
  );

  return map;
}
