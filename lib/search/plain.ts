import { t } from "@/lib/i18n/t";
import type { SpecialistId, TermKind } from "./types";

export function agentLabel(agent?: SpecialistId | "conductor" | string | null) {
  if (!agent) return t("terminal.agents.system");
  const key = `terminal.agents.${agent}`;
  const label = t(key);
  return label === key ? String(agent) : label;
}

/** Lead with the action; put the agent in parentheses so it stays light */
export function withAgent(
  action: string,
  agent?: SpecialistId | "conductor" | string | null,
): string {
  const body = action.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  const who = agentLabel(agent);
  return t("terminal.plain.withAgent", { action: body, agent: who });
}

/** Derive a readable summary from a detail line (legacy logs / missing plain) */
export function derivePlain(input: {
  kind: TermKind;
  text: string;
  agent?: SpecialistId;
}): string | null {
  const raw = input.text.replace(/^\[[^\]]+\]\s*/, "").trim();
  const agent = input.agent || guessAgent(input.text);

  if (input.kind === "curl") {
    const url = raw.match(/https?:\/\/[^\s'"]+/)?.[0];
    return withAgent(
      url
        ? t("terminal.plain.downloadingPage", { url: shortUrl(url) })
        : t("terminal.plain.fetchingData"),
      agent || "scout",
    );
  }
  if (input.kind === "python") {
    return withAgent(t("terminal.plain.scanningText"), agent || "contact");
  }
  if (input.kind === "err") {
    return withAgent(
      t("terminal.plain.issue", { msg: clip(raw, 110) }),
      agent,
    );
  }
  if (input.kind === "ok") {
    return withAgent(
      t("terminal.plain.done", { msg: clip(stripDecor(raw), 120) }),
      agent,
    );
  }

  if (/dispatch →\s*(\w+)/i.test(raw)) {
    const m = raw.match(/dispatch →\s*(\w+)/i);
    return withAgent(
      t("terminal.plain.handedWork", { agent: agentLabel(m?.[1]) }),
      "conductor",
    );
  }
  if (/REWIND →\s*(\w+)/i.test(raw)) {
    const m = raw.match(/REWIND →\s*(\w+)/i);
    return withAgent(
      t("terminal.plain.packageRejected", { agent: agentLabel(m?.[1]) }),
      "reviewer",
    );
  }
  if (/workflow complete|done ·/i.test(raw)) {
    return withAgent(t("terminal.plain.researchComplete"), "conductor");
  }
  if (/CANCEL|aborted \(canceled\)/i.test(raw)) {
    return withAgent(t("terminal.plain.jobCanceled"), "conductor");
  }
  if (/session|specialists:/i.test(raw)) {
    return withAgent(t("terminal.plain.researchStarted"), "conductor");
  }
  if (/online/i.test(raw)) {
    return withAgent(t("terminal.plain.startedTask"), agent);
  }
  if (/Ana sayfa|sayfa çek|home page|fetching home/i.test(raw)) {
    return withAgent(t("terminal.plain.reviewingHome"), agent || "scout");
  }
  if (/Ziyaret|Path denemesi|rota|visit|route/i.test(raw)) {
    return withAgent(t("terminal.plain.browsingPages"), agent || "scout");
  }
  if (/Şirket adı|Company name/i.test(raw)) {
    return withAgent(t("terminal.plain.extractingCompany"), agent || "scout");
  }
  if (
    /İlan–CV|ilan|job.?fit/i.test(raw) &&
    (input.agent === "jobfit" || /jobfit/i.test(input.text))
  ) {
    return withAgent(t("terminal.plain.lookingJobs"), "jobfit");
  }
  if (/e-posta|email|iletisim|İletişim|contact/i.test(raw)) {
    return withAgent(t("terminal.plain.lookingEmail"), agent || "contact");
  }
  if (/Sorgu:|Harici|şirket profili|Research|query/i.test(raw)) {
    return withAgent(t("terminal.plain.gatheringInfo"), agent || "research");
  }
  if (/Mail taslağı|Mail \(|draft/i.test(raw)) {
    return withAgent(t("terminal.plain.writingDraft"), agent || "writer");
  }
  if (/skor|PASS|REWIND|Paket|score/i.test(raw)) {
    return withAgent(t("terminal.plain.scoringPackage"), agent || "reviewer");
  }
  if (/Model düşünüyor|thinking|↳/i.test(raw)) {
    if (raw.startsWith("↳")) return null;
    return withAgent(t("terminal.plain.evaluating"), agent);
  }
  if (/bytes|preview:|stderr/i.test(raw)) {
    return null;
  }

  const cleaned = clip(stripDecor(raw), 140);
  if (!cleaned || cleaned.length < 3) return null;
  return withAgent(cleaned, agent);
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
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
