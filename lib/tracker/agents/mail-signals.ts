/**
 * Dedicated AI pass: language-agnostic per-mail intent.
 * Meaning over keywords — works in any language the model understands.
 */

import { SyncCanceledError, throwIfSyncCanceled } from "../cancel";
import { askTrackerLlm, extractJson } from "../llm";
import type { MailBrief } from "../match";
import {
  mergeMailIntent,
  normalizeIntent,
  regexMailIntent,
  type MailIntent,
  type MailIntentMap,
  type MailIntentRecord,
} from "../mail-kind";
import type { SyncProgressFn } from "../types";

type AiSignalsResponse = {
  signals?: Array<{
    mailId?: number;
    intent?: string;
    waitingUntil?: string | null;
    reason?: string;
  }>;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildPrompt(mails: MailBrief[]): string {
  return `You label INBOUND job-application emails by INTENT.

LANGUAGE: Detect meaning in ANY language (German, English, Turkish, French, Spanish, Dutch, Polish, Italian, Portuguese, …). Do NOT rely on fixed keywords — judge the communicative purpose.

Pick exactly ONE intent per mail:
- human_reply — a real human message that advances the process: asks a question, proposes interview, requests documents/info, gives a substantive update we must answer or act on by writing back.
- ack — thank-you / we received your application / we will get back / confirmation of receipt with NO real question and NO required button.
- auto_ack — automated/system receipt (auto-reply header, noreply recruiting bot, "we got your message, recruiters will contact you") that is NOT a personal OOO vacation.
- ooo — real out-of-office / vacation / absent until a date (person is away). Not a generic application receipt.
- rejection — soft or hard rejection / not moving forward / position filled / no suitable role.
- click_action — WE must click a REQUIRED link/button (verify email, GDPR consent button, activate account that expires). Not optional "view status".
- optional_portal — thank-you plus optional candidate portal / "you may view status" / create account ad — treat like ACK, not click_action.
- non_job — newsletter, marketing, personal chatter unrelated to a job application.
- unknown — cannot tell.

Also set waitingUntil as YYYY-MM-DD when intent=ooo and a return date is stated (any date format → ISO date). Else null.

Return ONLY JSON:
{"signals":[{"mailId":1,"intent":"ack","waitingUntil":null,"reason":"short"}]}

MAILS:
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

async function classifyBatch(
  mails: MailBrief[],
): Promise<MailIntentRecord[]> {
  const text = await askTrackerLlm(buildPrompt(mails));
  const parsed = extractJson<AiSignalsResponse>(text);
  if (!parsed?.signals || !Array.isArray(parsed.signals)) return [];

  const out: MailIntentRecord[] = [];
  for (const s of parsed.signals) {
    const mailId = Number(s.mailId);
    if (!Number.isFinite(mailId)) continue;
    out.push({
      mailId,
      intent: normalizeIntent(s.intent),
      waitingUntil: s.waitingUntil
        ? String(s.waitingUntil).slice(0, 10)
        : null,
      reason: s.reason ? String(s.reason).slice(0, 200) : undefined,
    });
  }
  return out;
}

function withRegexFallback(
  mail: MailBrief,
  ai: MailIntentRecord | undefined,
): MailIntentRecord {
  const regex = regexMailIntent(
    mail.subject,
    mail.bodyPreview || mail.snippet || "",
    mail.fromAddr,
    mail.toAddr,
  );
  const intent = mergeMailIntent(ai?.intent, regex);
  return {
    mailId: mail.id,
    intent,
    waitingUntil: ai?.waitingUntil || null,
    reason: ai?.reason,
  };
}

/**
 * Classify every INBOX mail. SENT skipped (not needed for silence noise).
 * AI + regex merge so DE/EN stay strong and other languages rely on AI.
 */
export async function classifyMailSignals(
  mails: MailBrief[],
  opts?: { onProgress?: SyncProgressFn; signal?: AbortSignal },
): Promise<MailIntentMap> {
  const log = opts?.onProgress;
  const signal = opts?.signal;
  const map: MailIntentMap = new Map();
  const inbox = mails.filter((m) => m.folder === "INBOX");

  if (!inbox.length) return map;

  const aiById = new Map<number, MailIntentRecord>();

  try {
    throwIfSyncCanceled(signal);
    const batches = chunk(inbox, 40);
    log?.(
      "think",
      `AI mail intent (${inbox.length} inbound, ${batches.length} batch)…`,
    );

    for (let i = 0; i < batches.length; i++) {
      throwIfSyncCanceled(signal);
      const batch = batches[i]!;
      try {
        const rows = await classifyBatch(batch);
        for (const row of rows) aiById.set(row.mailId, row);
        log?.(
          "ok",
          `intent batch ${i + 1}/${batches.length}: ${rows.length} etiket`,
        );
      } catch (err) {
        if (err instanceof SyncCanceledError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        log?.("system", `intent batch ${i + 1} başarısız → regex: ${msg}`);
      }
    }
  } catch (err) {
    if (err instanceof SyncCanceledError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    log?.("system", `AI intent atlandı → regex: ${msg}`);
  }

  let aiHits = 0;
  for (const m of inbox) {
    const ai = aiById.get(m.id);
    if (ai && ai.intent !== "unknown") aiHits += 1;
    map.set(m.id, withRegexFallback(m, ai));
  }

  const noise = [...map.values()].filter((r) =>
    ["ack", "auto_ack", "optional_portal", "ooo", "rejection"].includes(
      r.intent,
    ),
  ).length;
  log?.(
    "ok",
    `Mail intent: ${map.size} inbound · AI net ${aiHits} · sinyal ${noise}`,
  );

  return map;
}

/** Enrich group-level flags from last inbound intent (any language). */
export function flagsFromIntent(intent: MailIntent): {
  isAckOnly: boolean;
  isAutoReply: boolean;
  isClickAction: boolean;
  isRejected: boolean;
  isOoo: boolean;
} {
  return {
    isAckOnly:
      intent === "ack" ||
      intent === "auto_ack" ||
      intent === "optional_portal",
    isAutoReply: intent === "auto_ack" || intent === "ooo",
    isClickAction: intent === "click_action",
    isRejected: intent === "rejection",
    isOoo: intent === "ooo",
  };
}
