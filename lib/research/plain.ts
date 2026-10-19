import type { TVars } from "@/lib/i18n/lookup";
import type { SpecialistId, TermKind } from "./types";

export type TranslateFn = (key: string, vars?: TVars) => string;

const AGENT_KEYS = new Set([
  "conductor",
  "scout",
  "jobfit",
  "contact",
  "research",
  "writer",
  "reviewer",
  "system",
]);

export function agentLabel(
  agent: SpecialistId | "conductor" | string | null | undefined,
  t: TranslateFn,
): string {
  if (!agent) return t("terminal.agents.system");
  const id = String(agent).toLowerCase();
  if (AGENT_KEYS.has(id)) return t(`terminal.agents.${id}`);
  return String(agent);
}

/** Lead with the action; put the agent in parentheses so it stays light */
export function withAgent(
  action: string,
  agent: SpecialistId | "conductor" | string | null | undefined,
  t: TranslateFn,
): string {
  const body = action.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return t("terminal.plain.withAgent", {
    action: body,
    agent: agentLabel(agent, t),
  });
}

/**
 * Derive a readable summary from a detail line (legacy logs / missing plain).
 * Caller supplies `t` so this stays client-safe (no disk / server-only imports).
 */
export function derivePlain(input: {
  kind: TermKind;
  text: string;
  agent?: SpecialistId;
  t: TranslateFn;
}): string | null {
  const { t } = input;
  const raw = input.text.replace(/^\[[^\]]+\]\s*/, "").trim();
  const agent = input.agent || guessAgent(input.text);

  if (input.kind === "curl") {
    const url = raw.match(/https?:\/\/[^\s'"]+/)?.[0];
    return withAgent(
      url
        ? t("terminal.plain.downloadingPage", { url: shortUrl(url) })
        : t("terminal.plain.fetchingData"),
      agent || "scout",
      t,
    );
  }
  // Legacy job logs (pre JS-only email scan still tagged "python")
  if (input.kind === "python") {
    return withAgent(t("terminal.plain.scanningText"), agent || "contact", t);
  }
  if (input.kind === "err") {
    return withAgent(t("terminal.plain.issue", { msg: clip(raw, 110) }), agent, t);
  }
  if (input.kind === "ok") {
    return withAgent(
      t("terminal.plain.done", { msg: clip(stripDecor(raw), 120) }),
      agent,
      t,
    );
  }

  if (/dispatch →\s*(\w+)/i.test(raw)) {
    const m = raw.match(/dispatch →\s*(\w+)/i);
    return withAgent(
      t("terminal.plain.handedWork", {
        agent: agentLabel(m?.[1], t),
      }),
      "conductor",
      t,
    );
  }
  if (/REWIND →\s*(\w+)/i.test(raw)) {
    const m = raw.match(/REWIND →\s*(\w+)/i);
    return withAgent(
      t("terminal.plain.packageRejected", {
        agent: agentLabel(m?.[1], t),
      }),
      "reviewer",
      t,
    );
  }
  if (/workflow complete|done ·/i.test(raw)) {
    return withAgent(t("terminal.plain.researchComplete"), "conductor", t);
  }
  if (/CANCEL|aborted \(canceled\)/i.test(raw)) {
    return withAgent(t("terminal.plain.jobCanceled"), "conductor", t);
  }
  if (/session|specialists:/i.test(raw)) {
    return withAgent(t("terminal.plain.researchStarted"), "conductor", t);
  }
  if (/online/i.test(raw)) {
    return withAgent(t("terminal.plain.startedTask"), agent, t);
  }
  if (/Ana sayfa|sayfa çek|home page|fetching home/i.test(raw)) {
    return withAgent(t("terminal.plain.reviewingHome"), agent || "scout", t);
  }
  if (/Ziyaret|Path denemesi|rota|visit|route/i.test(raw)) {
    return withAgent(t("terminal.plain.browsingPages"), agent || "scout", t);
  }
  if (/Şirket adı|Company name/i.test(raw)) {
    return withAgent(t("terminal.plain.extractingCompany"), agent || "scout", t);
  }
  if (
    /İlan–CV|ilan|job.?fit/i.test(raw) &&
    (input.agent === "jobfit" || /jobfit/i.test(input.text))
  ) {
    return withAgent(t("terminal.plain.lookingJobs"), "jobfit", t);
  }
  if (/e-posta|email|iletisim|İletişim|contact/i.test(raw)) {
    return withAgent(
      t("terminal.plain.lookingEmail"),
      agent || "contact",
      t,
    );
  }
  if (/Sorgu:|Harici|şirket profili|Research|query/i.test(raw)) {
    return withAgent(
      t("terminal.plain.gatheringInfo"),
      agent || "research",
      t,
    );
  }
  if (/Mail taslağı|Mail \(|draft/i.test(raw)) {
    return withAgent(t("terminal.plain.writingDraft"), agent || "writer", t);
  }
  if (/skor|PASS|REWIND|Paket|score/i.test(raw)) {
    return withAgent(t("terminal.plain.scoringPackage"), agent || "reviewer", t);
  }
  if (/Model düşünüyor|thinking|↳/i.test(raw)) {
    if (raw.startsWith("↳")) return null;
    return withAgent(t("terminal.plain.evaluating"), agent, t);
  }
  if (/bytes|preview:|stderr/i.test(raw)) {
    return null;
  }

  const cleaned = clip(stripDecor(raw), 140);
  if (!cleaned || cleaned.length < 3) return null;
  return withAgent(cleaned, agent, t);
}

function guessAgent(text: string): string | undefined {
  const m = text.match(/^\[([a-z]+)\]/i);
  return m?.[1];
}

function stripDecor(s: string) {
  return s.replace(/^[◆▶⏪·↳✖\s$]+/, "").trim();
}

function shortUrl(u: string) {
  try {
    const x = new URL(u);
    return (
      x.hostname.replace(/^www\./, "") +
      (x.pathname === "/" ? "" : x.pathname.slice(0, 40))
    );
  } catch {
    return clip(u, 60);
  }
}

function clip(s: string, n: number) {
  const out = s.replace(/\s+/g, " ").trim();
  return out.length > n ? `${out.slice(0, n)}…` : out;
}
