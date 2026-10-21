/**
 * Lazy AI pass: summarize a company's mail thread set into short timeline events.
 */

import { t } from "@/lib/i18n/t";
import { askTrackerLlm, extractJson } from "../llm";

export const TIMELINE_MODEL = "composer-2.5";

export type TimelineEventKind =
  | "unknown_start"
  | "outbound"
  | "inbound"
  | "interview"
  | "accepted"
  | "rejected"
  | "followup"
  | "other";

export type TimelineEvent = {
  id: string;
  at: string | null;
  title: string;
  kind: TimelineEventKind;
  actors?: string[];
  confidence?: "high" | "medium" | "low";
  /** mail_messages.id values this summary card covers */
  mailIds?: number[];
};

export type TimelineOrigin = "unknown" | "app" | "mixed";

export type TimelineMailBrief = {
  id: number;
  folder: string;
  role: string;
  fromAddr: string;
  toAddr: string;
  subject: string;
  dateIso: string;
  snippet: string;
  bodyPreview: string;
};

export type GenerateTimelineInput = {
  company: string;
  position: string | null;
  locale: string;
  hasAppOrigin: boolean;
  mails: TimelineMailBrief[];
};

export type GenerateTimelineResult = {
  events: TimelineEvent[];
  origin: TimelineOrigin;
};

const KINDS = new Set<string>([
  "unknown_start",
  "outbound",
  "inbound",
  "interview",
  "accepted",
  "rejected",
  "followup",
  "other",
]);

function normalizeKind(raw: unknown): TimelineEventKind {
  const k = String(raw || "").trim();
  return KINDS.has(k) ? (k as TimelineEventKind) : "other";
}

function normalizeOrigin(raw: unknown, fallback: TimelineOrigin): TimelineOrigin {
  const o = String(raw || "").trim();
  if (o === "unknown" || o === "app" || o === "mixed") return o;
  return fallback;
}

function buildPrompt(input: GenerateTimelineInput): string {
  const lang = input.locale || "en";
  const appHint = input.hasAppOrigin
    ? "Application MAY have started via CMAE (research/workspace folder exists). Still mark origin unknown if the first outbound application mail is missing from this set."
    : "Application was NOT started via CMAE in this dataset. You MUST start the timeline with an unknown_start event (at: null) describing that the initial application is unknown.";

  return `You summarize a job-application email history into a short visual timeline for the candidate.

GOAL
- Help them instantly remember what happened with this company across multiple people/threads.
- Write VERY short event titles (one line, max ~12 words). Past tense. Concrete (dates, interview, questions, rejection).
- Do NOT invent facts. Prefer "Probably…" / low confidence when inferring (e.g. interview likely happened).
- Merge related mails into one event when they are the same beat (do not one-card-per-mail).
- Order events chronologically. unknown_start always first when used.
- Every real mail id MUST appear in exactly one event's mailIds (no orphans, no duplicates).
- unknown_start may have mailIds: [] when the first application mail is missing.
- mailIds must be the numeric \`id\` fields from MAILS below.

ORIGIN
- unknown: first application mail not in set / not via CMAE
- app: clear first application outbound from the user via this app context
- mixed: some parts via app, earlier history unknown
${appHint}

LANGUAGE
- Write every title in language code: ${lang}
- Keep company/person names as in the mails.

KINDS (pick one per event):
unknown_start | outbound | inbound | interview | accepted | rejected | followup | other

Return ONLY JSON:
{
  "origin": "unknown",
  "events": [
    {
      "id": "e1",
      "at": "2025-10-01" or null,
      "title": "short summary",
      "kind": "inbound",
      "actors": ["Name"],
      "confidence": "high",
      "mailIds": [12, 15]
    }
  ]
}

COMPANY: ${input.company}
POSITION: ${input.position || "—"}

MAILS (chronological):
${JSON.stringify(
  input.mails.map((m) => ({
    id: m.id,
    folder: m.folder,
    role: m.role,
    from: m.fromAddr,
    to: m.toAddr,
    subject: m.subject,
    date: m.dateIso.slice(0, 10),
    snippet: m.snippet.slice(0, 280),
    body: m.bodyPreview.slice(0, 600),
  })),
  null,
  2,
)}
`;
}

function parseEvents(raw: unknown[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  let i = 0;
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const row = e as Record<string, unknown>;
    const title = String(row.title || "").trim();
    if (!title) continue;
    i += 1;
    const atRaw = row.at;
    const at =
      atRaw === null || atRaw === undefined || atRaw === ""
        ? null
        : String(atRaw).slice(0, 10);
    const actors = Array.isArray(row.actors)
      ? row.actors
          .map((a) => String(a).trim())
          .filter(Boolean)
          .slice(0, 6)
      : undefined;
    const conf = String(row.confidence || "").trim();
    const confidence =
      conf === "high" || conf === "medium" || conf === "low"
        ? conf
        : undefined;
    const mailIds = Array.isArray(row.mailIds)
      ? row.mailIds
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0)
          .slice(0, 40)
      : undefined;
    out.push({
      id: String(row.id || `e${i}`).slice(0, 40),
      at,
      title: title.slice(0, 200),
      kind: normalizeKind(row.kind),
      actors: actors?.length ? actors : undefined,
      confidence,
      mailIds: mailIds?.length ? mailIds : undefined,
    });
  }
  return out.slice(0, 40);
}

export type AttachableMail = {
  id: number;
  dateIso: string;
  folder?: string;
  fromAddr?: string;
  toAddr?: string;
  subject?: string;
};

const OUTBOUND_KINDS = new Set<TimelineEventKind>([
  "outbound",
  "followup",
]);
const INBOUND_KINDS = new Set<TimelineEventKind>([
  "inbound",
  "interview",
  "accepted",
  "rejected",
  "other",
]);

function mailPeopleBlob(m: AttachableMail): string {
  return `${m.fromAddr || ""} ${m.toAddr || ""}`.toLowerCase();
}

function actorMatchScore(ev: TimelineEvent, m: AttachableMail): number {
  const actors = ev.actors || [];
  if (!actors.length) return 0;
  const people = mailPeopleBlob(m);
  let hit = 0;
  for (const a of actors) {
    const token = a.trim().toLowerCase();
    if (token.length < 3) continue;
    // match "Clara Kruggel" ↔ clara.kruggel@…
    const parts = token.split(/\s+/).filter((p) => p.length >= 3);
    if (parts.some((p) => people.includes(p))) hit += 1;
  }
  return hit * 40;
}

function folderKindScore(ev: TimelineEvent, m: AttachableMail): number {
  const folder = (m.folder || "").toUpperCase();
  if (folder === "SENT") {
    if (OUTBOUND_KINDS.has(ev.kind)) return 50;
    if (INBOUND_KINDS.has(ev.kind)) return -35;
    return 0;
  }
  if (folder === "INBOX") {
    if (INBOUND_KINDS.has(ev.kind)) return 50;
    if (OUTBOUND_KINDS.has(ev.kind)) return -35;
    return 0;
  }
  return 0;
}

/**
 * Ensure every mail is attached to exactly one event.
 * Prefer AI mailIds; fill gaps with day + folder/kind + actor scoring
 * (never dump all same-day mails onto the first card).
 */
export function attachMailsToEvents(
  events: TimelineEvent[],
  mails: AttachableMail[],
): TimelineEvent[] {
  if (!events.length) return events;
  if (!mails.length) {
    return events.map((e) => ({ ...e, mailIds: e.mailIds ?? [] }));
  }

  const valid = new Set(mails.map((m) => m.id));
  const used = new Set<number>();
  const next = events.map((e) => {
    const ids: number[] = [];
    for (const id of e.mailIds || []) {
      if (!valid.has(id) || used.has(id)) continue;
      used.add(id);
      ids.push(id);
    }
    return { ...e, mailIds: ids };
  });

  const remaining = mails
    .filter((m) => !used.has(m.id))
    .sort((a, b) => a.dateIso.localeCompare(b.dateIso));

  for (const m of remaining) {
    const day = m.dateIso.slice(0, 10);
    const mailTs = Date.parse(m.dateIso);
    let best = -1;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < next.length; i++) {
      const ev = next[i]!;
      // Skip empty unknown_start placeholders unless nothing else fits
      if (ev.kind === "unknown_start" && !ev.at && next.length > 1) continue;
      // Inferred phone/etc. with no mail signal — avoid parking real mails here
      // unless it is the only same-day candidate after scoring.
      let score = 0;

      const at = ev.at;
      if (at) {
        if (at === day) score += 100;
        else {
          const dayDiff = Math.abs(
            Date.parse(`${at}T12:00:00`) - Date.parse(`${day}T12:00:00`),
          );
          if (!Number.isFinite(dayDiff)) continue;
          // More than ~3 days away is a weak candidate
          score += Math.max(0, 80 - dayDiff / 86_400_000);
          if (at > day) score -= 25;
        }
      } else {
        score -= 20;
      }

      score += folderKindScore(ev, m);
      const actorHit = actorMatchScore(ev, m);
      score += actorHit;
      // Event named a person but this mail is someone else → strong reject
      if ((ev.actors?.length || 0) > 0 && actorHit === 0) score -= 55;

      // Chronology: among same-day events, prefer the event whose order
      // aligns with mail order (earlier mails → earlier events).
      if (at === day && Number.isFinite(mailTs)) {
        const sameDayIdx = next
          .map((e, idx) => ({ e, idx }))
          .filter(({ e }) => e.at === day);
        const pos = sameDayIdx.findIndex(({ idx }) => idx === i);
        if (pos >= 0 && sameDayIdx.length > 1) {
          const sameDayMails = remaining.filter(
            (x) => x.dateIso.slice(0, 10) === day,
          );
          const mailPos = sameDayMails.findIndex((x) => x.id === m.id);
          if (mailPos >= 0) {
            const ideal =
              (mailPos / Math.max(1, sameDayMails.length - 1)) *
              (sameDayIdx.length - 1);
            score += 20 - Math.abs(pos - ideal) * 12;
          }
        }
      }

      // Soft load-balance so one card cannot vacuum the whole day
      score -= (ev.mailIds?.length || 0) * 8;

      // Inferred "probably interview/call" beats must not steal real mails
      // unless the AI already linked them (those arrive via mailIds above).
      if (ev.kind === "interview") score -= 120;

      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }

    if (best < 0) {
      // last resort: first dated event, else last
      best =
        next.findIndex((e) => e.at) >= 0
          ? next.findIndex((e) => e.at)
          : next.length - 1;
    }
    next[best]!.mailIds = [...(next[best]!.mailIds || []), m.id];
  }

  return next;
}

/** True when cached events never stored mail↔card links (pre-feature / incomplete AI). */
export function eventsMissingMailLinks(events: TimelineEvent[]): boolean {
  if (!events.length) return false;
  return !events.some((e) => (e.mailIds?.length || 0) > 0);
}

export async function generateTimelineSummary(
  input: GenerateTimelineInput,
): Promise<GenerateTimelineResult> {
  const fallbackOrigin: TimelineOrigin = input.hasAppOrigin ? "mixed" : "unknown";
  const text = await askTrackerLlm(buildPrompt(input), { feature: "tracker.timeline" });
  const parsed = extractJson<{
    origin?: string;
    events?: unknown[];
  }>(text);

  let events = Array.isArray(parsed?.events)
    ? parseEvents(parsed!.events!)
    : [];
  let origin = normalizeOrigin(parsed?.origin, fallbackOrigin);

  if (!input.hasAppOrigin) {
    origin = origin === "app" ? "unknown" : origin;
    if (!events.some((e) => e.kind === "unknown_start")) {
      events = [
        {
          id: "e0",
          at: null,
          title: t("tracker.detailPage.fallbackUnknownStart"),
          kind: "unknown_start",
          confidence: "medium",
          mailIds: [],
        },
        ...events,
      ];
    }
  }

  if (!events.length) {
    events = [
      {
        id: "e0",
        at: null,
        title: t("tracker.detailPage.fallbackEmptyTimeline"),
        kind: "other",
        confidence: "low",
        mailIds: [],
      },
    ];
  }

  events = attachMailsToEvents(
    events,
    input.mails.map((m) => ({
      id: m.id,
      dateIso: m.dateIso,
      folder: m.folder,
      fromAddr: m.fromAddr,
      toAddr: m.toAddr,
      subject: m.subject,
    })),
  );

  return { events, origin };
}
