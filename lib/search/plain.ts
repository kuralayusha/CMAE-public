import type { SpecialistId, TermKind } from "./types";

/** English labels — app language. Client-safe (no fs). */
const AGENT_EN: Record<string, string> = {
  conductor: "Conductor",
  scout: "Scout agent",
  jobfit: "Job-fit agent",
  contact: "Contact agent",
  research: "Research agent",
  writer: "Writer agent",
  reviewer: "Reviewer agent",
};

export function agentLabel(agent?: SpecialistId | "conductor" | string | null) {
  if (!agent) return "System";
  return AGENT_EN[agent] || agent;
}

/** Lead with the action; put the agent in parentheses so it stays light */
export function withAgent(
  action: string,
  agent?: SpecialistId | "conductor" | string | null,
): string {
  const body = action.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  const who = agentLabel(agent);
  return `${body}. (${who})`;
}

/**
 * Derive a readable summary from a detail line (legacy logs / missing plain).
 * Emits English (app language). Server `speak()` may replace with user-locale plain.
 */
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
        ? `Downloading web page: ${shortUrl(url)}`
        : "Fetching data from the internet",
      agent || "scout",
    );
  }
  if (input.kind === "python") {
    return withAgent("Scanning text for emails / patterns", agent || "contact");
  }
  if (input.kind === "err") {
    return withAgent(`Issue: ${clip(raw, 110)}`, agent);
  }
  if (input.kind === "ok") {
    return withAgent(`Done: ${clip(stripDecor(raw), 120)}`, agent);
  }

  if (/dispatch →\s*(\w+)/i.test(raw)) {
    const m = raw.match(/dispatch →\s*(\w+)/i);
    return withAgent(
      `Handed work to ${agentLabel(m?.[1])} agent`,
      "conductor",
    );
  }
  if (/REWIND →\s*(\w+)/i.test(raw)) {
    const m = raw.match(/REWIND →\s*(\w+)/i);
    return withAgent(
      `Package rejected; retrying from ${agentLabel(m?.[1])} step`,
      "reviewer",
    );
  }
  if (/workflow complete|done ·/i.test(raw)) {
    return withAgent("Research complete", "conductor");
  }
  if (/CANCEL|aborted \(canceled\)/i.test(raw)) {
    return withAgent("Job canceled by user", "conductor");
  }
  if (/session|specialists:/i.test(raw)) {
    return withAgent("Research started", "conductor");
  }
  if (/online/i.test(raw)) {
    return withAgent("Started task", agent);
  }
  if (/Ana sayfa|sayfa çek|home page|fetching home/i.test(raw)) {
    return withAgent("Reviewing the site home page", agent || "scout");
  }
  if (/Ziyaret|Path denemesi|rota|visit|route/i.test(raw)) {
    return withAgent("Browsing related pages", agent || "scout");
  }
  if (/Şirket adı|Company name/i.test(raw)) {
    return withAgent("Extracting company name", agent || "scout");
  }
  if (
    /İlan–CV|ilan|job.?fit/i.test(raw) &&
    (input.agent === "jobfit" || /jobfit/i.test(input.text))
  ) {
    return withAgent("Looking for open roles that match the CV", "jobfit");
  }
  if (/e-posta|email|iletisim|İletişim|contact/i.test(raw)) {
    return withAgent(
      "Looking for a suitable application email",
      agent || "contact",
    );
  }
  if (/Sorgu:|Harici|şirket profili|Research|query/i.test(raw)) {
    return withAgent(
      "Gathering company info from external sources",
      agent || "research",
    );
  }
  if (/Mail taslağı|Mail \(|draft/i.test(raw)) {
    return withAgent("Writing application email draft", agent || "writer");
  }
  if (/skor|PASS|REWIND|Paket|score/i.test(raw)) {
    return withAgent("Scoring the application package", agent || "reviewer");
  }
  if (/Model düşünüyor|thinking|↳/i.test(raw)) {
    if (raw.startsWith("↳")) return null;
    return withAgent("Evaluating status", agent);
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
