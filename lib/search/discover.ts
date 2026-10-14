import * as cheerio from "cheerio";
import { runCurl, runPython } from "./shell";
import { emitLine } from "./events";
import { askLlm, extractJson } from "./llm";

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
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:"))
      return;
    try {
      const abs = new URL(href, url).toString();
      if (!/^https?:/i.test(abs)) return;
      links.push({ href: abs, text: text.slice(0, 120) });
    } catch {
      /* ignore */
    }
  });

  const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 20000);
  return { url, title, text, links: dedupeLinks(links) };
}

/**
 * Orkestra kararı: hangi linkler kariyer/iletişim/şirket bilgisi için ziyaret edilmeli?
 * Dil bağımsız — Çince, Arapça, İtalyanca vb. AI anlar.
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
      "reason": "why visit, in Turkish",
      "priority": 1
    }
  ],
  "pathGuesses": [
    "/... relative paths that are likely on THIS site's language/locale for careers and contact if missing from links"
  ],
  "notes": "short planner note in Turkish"
}

Rules:
- Prefer roles useful for: open jobs, hiring emails, company understanding.
- careers/jobs pages outrank generic contact when both exist.
- pathGuesses: invent locale-appropriate paths (e.g. Chinese site might use /招聘 or /join-us — decide from context). Max 8.
- Max 12 routes. priority 1 = visit first.
- Only same-origin hrefs.`,
    "AI rota planı (dil-bağımsız)…",
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

  // AI boş dönerse: ilk N linki mekanik fallback (kural yok, sadece örneklem)
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
            reason: "AI plan boş — örneklem fallback",
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

/** AI: hangi e-postalar hiring için daha doğru? */
export async function rankEmailsWithAi(
  jobId: string,
  companyName: string,
  items: { email: string; page: string; pageRole?: string }[],
): Promise<RankedEmail[]> {
  if (!items.length) return [];

  const list = items
    .map(
      (e, i) =>
        `${i + 1}. ${e.email} | page=${e.page} | pageRole=${e.pageRole || "unknown"}`,
    )
    .join("\n");

  const raw = await askLlm(
    jobId,
    `You rank company emails for a job seeker cold/application outreach.
Company: ${companyName}

Candidates:
${list}

Prefer (in order): recruiting/HR/careers mailbox → role-relevant team → general company contact.
Deprioritize: noreply, newsletter, privacy, support ticket bots, personal random if clearly unrelated.

Return ONLY JSON:
{
  "ranked": [
    {
      "email": "",
      "page": "",
      "role": "careers|hr|contact|info|other",
      "priority": 1,
      "reason": "Turkish one-liner"
    }
  ]
}`,
    "AI e-posta önceliklendirme…",
    "contact",
  );

  const parsed = extractJson<{ ranked?: RankedEmail[] }>(raw);
  if (parsed?.ranked?.length) {
    return parsed.ranked
      .filter((r) => r.email)
      .sort((a, b) => (a.priority || 99) - (b.priority || 99));
  }

  // fallback: preserve discovery order, no language heuristics
  return items.map((e, i) => ({
    email: e.email,
    page: e.page,
    role: e.pageRole || "other",
    priority: i + 1,
    reason: "AI sıralama yok — keşif sırası",
  }));
}

/** AI: harici arama sorguları (dil/platform siteye göre) */
export async function planExternalQueriesWithAi(
  jobId: string,
  companyName: string,
  siteLanguage: string,
  baseUrl: string,
): Promise<string[]> {
  const raw = await askLlm(
    jobId,
    `Generate 2-3 web search queries to learn what "${companyName}" does beyond its own website (${baseUrl}).
Site language hint: ${siteLanguage}
Mix languages if useful (local press + English). Include platforms that make sense for THAT market (not always LinkedIn/Western sites).

Return ONLY JSON: { "queries": ["...", "..."] }`,
    "AI harici arama sorguları…",
    "research",
  );
  const parsed = extractJson<{ queries?: string[] }>(raw);
  const queries = (parsed?.queries || []).map((q) => String(q).trim()).filter(Boolean);
  if (queries.length) return queries.slice(0, 3);
  return [`${companyName}`, `${companyName} ${siteLanguage}`];
}

export async function extractEmails(jobId: string, htmlOrText: string, sourceUrl: string) {
  emitLine(jobId, "think", `E-posta pattern taraması: ${sourceUrl}`);

  const jsEmails = extractEmailsJs(htmlOrText);

  const sample = htmlOrText.slice(0, 8000);
  const b64 = Buffer.from(sample, "utf8").toString("base64");
  const script = `
import re, json, base64
text = base64.b64decode("${b64}").decode("utf-8", errors="ignore")
# Sites hide emails: name[at]co.com / name(at)co.com / name[dot]co[dot]com
text = re.sub(r"&#64;|&at;", "@", text, flags=re.I)
text = re.sub(r"&#46;", ".", text)
text = re.sub(r"\\s*[\\[\\(\\{<]\\s*(?:at|ät|AT)\\s*[\\]\\)\\}>]\\s*", "@", text)
text = re.sub(r"\\s*[\\[\\(\\{<]\\s*(?:dot|punkt|\\.)\\s*[\\]\\)\\}>]\\s*", ".", text, flags=re.I)
emails = set(re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", text))
for m in re.finditer(
    r"([A-Za-z0-9._%+-]+)\\s+(?:at|ät)\\s+([A-Za-z0-9.-]+\\.[A-Za-z]{2,})",
    text,
    re.I,
):
    emails.add(f"{m.group(1)}@{m.group(2)}")
emails = sorted(e for e in emails if not re.search(r"\\.(png|jpg|gif|svg|webp)$", e, re.I))
print(json.dumps(emails[:40], ensure_ascii=False))
`.trim();

  const { stdout } = await runPython(jobId, script);
  let pyEmails: string[] = [];
  try {
    pyEmails = JSON.parse(stdout || "[]") as string[];
  } catch {
    pyEmails = [];
  }

  return [...new Set([...jsEmails, ...pyEmails].map((e) => e.toLowerCase()))];
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
  while ((m = spacedAt.exec(text)) !== null) {
    const email = `${m[1]}@${m[2]}`;
    if (isPlausibleEmail(email)) out.add(email.toLowerCase());
  }

  // mailto:
  const mailto = /mailto:([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi;
  while ((m = mailto.exec(text)) !== null) {
    if (isPlausibleEmail(m[1]!)) out.add(m[1]!.toLowerCase());
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
