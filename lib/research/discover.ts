import * as cheerio from "cheerio";
import { t } from "@/lib/i18n/t";
import { runCurl } from "./shell";
import { emitLine } from "./events";
import { askLlm, extractJson } from "./llm";
import { withAgent } from "./plain";

export type DiscoveredPage = {
  url: string;
  title: string;
  text: string;
  links: { href: string; text: string }[];
};

export type PlannedRoute = {
  href: string;
  text: string;
  role: string;
  reason: string;
  priority: number;
};

export type RankedEmail = {
  email: string;
  page: string;
  role: string;
  priority: number;
  reason: string;
};

/** Saf mekanik fetch — dil/kural yok */
export async function fetchPage(jobId: string, url: string): Promise<DiscoveredPage> {
  const { stdout, code } = await runCurl(jobId, [
    "-sL",
    "--max-time",
    "35",
    "-A",
    "Mozilla/5.0 (compatible; CMAEBot/1.0)",
    url,
  ]);

  if (code !== 0 || !stdout) {
    return { url, title: "", text: "", links: [] };
  }

  const $ = cheerio.load(stdout);
  $("script, style, noscript, svg, iframe").remove();
  const title = $("title").first().text().replace(/\s+/g, " ").trim();
  const links: { href: string; text: string }[] = [];
  /** Many sites only expose emails via mailto: href — not as visible body text. */
  const mailtoEmails: string[] = [];
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!href || href.startsWith("#") || href.startsWith("tel:")) return;
    if (/^mailto:/i.test(href)) {
      const raw = href.replace(/^mailto:/i, "").split("?")[0] || "";
      try {
        const decoded = decodeURIComponent(raw).trim();
        const m = decoded.match(
          /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
        );
        if (m) mailtoEmails.push(m[0]);
      } catch {
        /* ignore bad encoding */
      }
      return;
    }
    try {
      const abs = new URL(href, url).toString();
      if (!/^https?:/i.test(abs)) return;
      links.push({ href: abs, text: text.slice(0, 120) });
    } catch {
      /* ignore */
    }
  });

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const mailtoSuffix =
    mailtoEmails.length > 0
      ? ` ${[...new Set(mailtoEmails.map((e) => e.toLowerCase()))].join(" ")}`
      : "";
  const text = `${bodyText}${mailtoSuffix}`.trim().slice(0, 20000);
  return { url, title, text, links: dedupeLinks(links) };
}

/**
 * Conductor decision: which links to visit for careers/contact/company info?
 * Language-agnostic — AI understands Chinese, Arabic, Italian, etc.
 */
export async function planRoutesWithAi(
  jobId: string,
  baseUrl: string,
  home: DiscoveredPage,
): Promise<{
  siteLanguage: string;
  routes: PlannedRoute[];
  pathGuesses: string[];
  notes: string;
}> {
  const origin = new URL(baseUrl).origin;
  const catalog = home.links
    .filter((l) => {
      try {
        return new URL(l.href).origin === origin;
      } catch {
        return false;
      }
    })
    .slice(0, 80)
    .map((l, i) => `${i + 1}. "${l.text || "(no text)"}" → ${l.href}`)
    .join("\n");

  const raw = await askLlm(
    jobId,
    "research.discover",
    `You are a multilingual web reconnaissance planner for a job-application agent.
The site may be in ANY language (Chinese, Arabic, Italian, Turkish, English, etc.).
Do NOT assume English path names. Infer meaning from link text + URL + page context.

Base URL: ${baseUrl}
Page title: ${home.title}
Page excerpt:
${home.text.slice(0, 3500)}

Same-origin links:
${catalog || "(no links extracted)"}

Return ONLY JSON:
{
  "siteLanguage": "detected BCP-47-ish code, e.g. zh, ar, it, tr, en",
  "routes": [
    {
      "href": "absolute url from the list (or carefully constructed same-origin url)",
      "text": "link text",
      "role": "careers|jobs|contact|about|team|blog|product|other",
      "reason": "why visit, in English",
      "priority": 1
    }
  ],
  "pathGuesses": [
    "/... relative paths that are likely on THIS site's language/locale for careers and contact if missing from links"
  ],
  "notes": "short planner note in English"
}

Rules:
- Prefer roles useful for: open jobs, hiring emails, company understanding.
- careers/jobs pages outrank generic contact when both exist.
- pathGuesses: invent locale-appropriate paths (e.g. Chinese site might use /招聘 or /join-us — decide from context). Max 8.
- Max 12 routes. priority 1 = visit first.
- Only same-origin hrefs.`,
    t("terminal.llm.routePlan"),
    "scout",
  );

  const parsed = extractJson<{
    siteLanguage?: string;
    routes?: PlannedRoute[];
    pathGuesses?: string[];
    notes?: string;
  }>(raw);

  const routes = (parsed?.routes || [])
    .filter((r) => r?.href)
    .map((r, i) => ({
      href: absolutize(baseUrl, r.href),
      text: r.text || "",
      role: r.role || "other",
      reason: r.reason || "",
      priority: Number(r.priority) || i + 1,
    }))
    .filter((r) => sameOrigin(baseUrl, r.href))
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 12);

  // If AI returns empty: mechanical fallback to first N links (sample only)
  const fallbackRoutes: PlannedRoute[] =
    routes.length > 0
      ? routes
      : home.links
          .filter((l) => sameOrigin(baseUrl, l.href))
          .slice(0, 8)
          .map((l, i) => ({
            href: l.href,
            text: l.text,
            role: "other",
            reason: "AI plan empty — sample fallback",
            priority: i + 1,
          }));

  const pathGuesses = (parsed?.pathGuesses || [])
    .map((p) => String(p).trim())
    .filter((p) => p.startsWith("/"))
    .slice(0, 8);

  return {
    siteLanguage: parsed?.siteLanguage || "und",
    routes: fallbackRoutes,
    pathGuesses,
    notes: parsed?.notes || "",
  };
}

/** AI: which emails are better for hiring outreach? */
export async function rankEmailsWithAi(
  jobId: string,
  companyName: string,
  items: { email: string; page: string; pageRole?: string }[],
  targetUrl?: string,
  preferredLang = "en",
): Promise<RankedEmail[]> {
  if (!items.length) return [];

  const pref = preferredLang.trim() || "en";
  const allowed = new Set(items.map((e) => e.email.toLowerCase()));
  const list = items
    .map(
      (e, i) =>
        `${i + 1}. ${e.email} | page=${e.page} | pageRole=${e.pageRole || "unknown"}`,
    )
    .join("\n");

  const raw = await askLlm(
    jobId,
    "research.discover",
    `You rank company emails for a job seeker cold/application outreach.
Company (TARGET): ${companyName}
Target URL: ${targetUrl || "(given site)"}

Candidates (ONLY these — never invent or add emails from other companies):
${list}

Prefer (in order): recruiting/HR/careers mailbox → role-relevant team → general company contact.
Deprioritize: noreply, newsletter, privacy, support ticket bots, personal random if clearly unrelated.
HARD RULE: Rank only from the candidate list above. Do not invent addresses for a different employer/domain. The outreach target is the entity at Target URL, not companies merely mentioned on the page.
CRITICAL LANGUAGE RULE: Write every "reason" in preferred language code "${pref}" (natural tone for that language). Do not write reasons in English unless "${pref}" is English.

Return ONLY JSON:
{
  "ranked": [
    {
      "email": "",
      "page": "",
      "role": "careers|hr|contact|info|other",
      "priority": 1,
      "reason": "one-liner why this address, in language ${pref}"
    }
  ]
}`,
    t("terminal.llm.emailRank"),
    "contact",
  );

  const parsed = extractJson<{ ranked?: RankedEmail[] }>(raw);
  if (parsed?.ranked?.length) {
    const filtered = parsed.ranked
      .filter((r) => r.email && allowed.has(String(r.email).toLowerCase()))
      .sort((a, b) => (a.priority || 99) - (b.priority || 99));
    if (filtered.length) return filtered;
  }

  // fallback: preserve discovery order, no language heuristics
  return items.map((e, i) => ({
    email: e.email,
    page: e.page,
    role: e.pageRole || "other",
    priority: i + 1,
    reason: "No AI ranking — discovery order",
  }));
}

/** AI: external search queries (language/platform per site) */
export async function planExternalQueriesWithAi(
  jobId: string,
  companyName: string,
  siteLanguage: string,
  baseUrl: string,
): Promise<string[]> {
  const raw = await askLlm(
    jobId,
    "research.discover",
    `Generate 2-3 web search queries to learn more about THIS target only: "${companyName}" at ${baseUrl}.
Site language hint: ${siteLanguage}
Mix languages if useful (local press + English). Include platforms that make sense for THAT market (not always LinkedIn/Western sites).

HARD RULE: Queries must research the entity that owns ${baseUrl} ("${companyName}"). Do not pivot to employers, clients, or partners merely mentioned on that site. External search is enrichment for the same target — never a new target.

Return ONLY JSON: { "queries": ["...", "..."] }`,
    t("terminal.llm.externalQueries"),
    "research",
  );
  const parsed = extractJson<{ queries?: string[] }>(raw);
  const queries = (parsed?.queries || []).map((q) => String(q).trim()).filter(Boolean);
  if (queries.length) return queries.slice(0, 3);
  return [`${companyName}`, `${companyName} ${siteLanguage}`];
}

export async function extractEmails(jobId: string, htmlOrText: string, sourceUrl: string) {
  emitLine(
    jobId,
    "think",
    t("terminal.detail.emailScan", { url: sourceUrl }),
    "contact",
    withAgent(t("terminal.plain.emailScan"), "contact", t),
  );

  const emails = extractEmailsJs(htmlOrText).slice(0, 40);
  const list = emails.length
    ? `: ${emails.slice(0, 5).join(", ")}${emails.length > 5 ? "…" : ""}`
    : "";
  emitLine(
    jobId,
    "system",
    t("terminal.detail.emailCandidates", {
      count: emails.length,
      list,
    }),
    "contact",
    withAgent(
      emails.length
        ? t("terminal.plain.emailScanDone", { count: emails.length })
        : t("terminal.plain.emailScanEmpty"),
      "contact",
      t,
    ),
  );
  return emails;
}

/** Plain + obfuscated emails: name[at]co.com, name(at)co.com, name at co.com, [dot] */
function extractEmailsJs(text: string): string[] {
  const normalized = deobfuscateEmailText(text);
  const out = new Set<string>();

  const plain = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  for (const m of normalized.match(plain) || []) {
    if (isPlausibleEmail(m)) out.add(m.toLowerCase());
  }

  // Spaced "at" / "ät" that global replace might miss next to punctuation
  const spacedAt =
    /([A-Za-z0-9._%+-]+)\s+(?:at|ät)\s+([A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi;
  let m: RegExpExecArray | null;
  for (const source of [text, normalized]) {
    spacedAt.lastIndex = 0;
    while ((m = spacedAt.exec(source)) !== null) {
      const email = `${m[1]}@${m[2]}`;
      if (isPlausibleEmail(email)) out.add(email.toLowerCase());
    }
  }

  // mailto: (raw + deobfuscated)
  const mailto = /mailto:([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi;
  for (const source of [text, normalized]) {
    mailto.lastIndex = 0;
    while ((m = mailto.exec(source)) !== null) {
      if (isPlausibleEmail(m[1]!)) out.add(m[1]!.toLowerCase());
    }
  }

  return [...out];
}

function deobfuscateEmailText(text: string): string {
  return text
    .replace(/&#64;|&at;/gi, "@")
    .replace(/&#46;/g, ".")
    .replace(/\s*[\[({<]\s*(?:at|ät|AT)\s*[\])}>]\s*/g, "@")
    .replace(/\s*[\[({<]\s*(?:dot|punkt|\.)\s*[\])}>]\s*/gi, ".");
}

function isPlausibleEmail(email: string): boolean {
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) {
    return false;
  }
  if (/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(email)) return false;
  return true;
}

function absolutize(base: string, href: string) {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function sameOrigin(base: string, href: string) {
  try {
    return new URL(href).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function dedupeLinks(links: { href: string; text: string }[]) {
  const seen = new Set<string>();
  return links.filter((l) => {
    const key = l.href.replace(/\/$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
