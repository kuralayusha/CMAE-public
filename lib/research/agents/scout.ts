import {
  hostBrandHint,
  resolveCompanyName,
  type CompanyIdentityGuess,
  type SiteKind,
} from "../company-identity";
import {
  fetchPage,
  planRoutesWithAi,
  type DiscoveredPage,
} from "../discover";
import { JobCanceledError, throwIfCanceled } from "../cancel";
import type { RunContext } from "../context";
import { askLlm, extractJson } from "../llm";
import { speak } from "../speak";
import { getJob, setJobStatus } from "../events";
import { createCompanyFolder, renameCompanyFolder, writeFile } from "../workspace";

export async function runScout(ctx: RunContext) {
  const { jobId, url } = ctx;
  speak(jobId, "scout", "system", "── scout online · discovery & route plan");
  throwIfCanceled(jobId);

  if (ctx.redoFeedback.scout) {
    speak(jobId, "scout", "think", `Reviewer feedback: ${ctx.redoFeedback.scout}`);
  }

  let host = "Company";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (!ctx.folderPath) {
    const folder = await createCompanyFolder(host);
    ctx.folderName = folder.folderName;
    ctx.folderPath = folder.folderPath;
    const job = getJob(jobId);
    if (job) {
      job.folderName = folder.folderName;
      job.folderPath = folder.folderPath;
    }
    speak(jobId, "scout", "ok", `workspace → ${folder.folderName}/`);
  }

  speak(jobId, "scout", "think", "Fetching homepage…");
  const home = await fetchPage(jobId, url);
  throwIfCanceled(jobId);
  ctx.home = home;

  const plan = await planRoutesWithAi(jobId, url, home);
  throwIfCanceled(jobId);
  ctx.siteLanguage = plan.siteLanguage;
  ctx.routes = plan.routes;
  ctx.pathGuesses = plan.pathGuesses;
  ctx.planNotes = plan.notes;

  speak(
    jobId,
    "scout",
    "think",
    `lang≈${plan.siteLanguage} · ${plan.routes.length} routes · ${plan.pathGuesses.length} paths`,
  );
  for (const r of plan.routes.slice(0, 10)) {
    speak(
      jobId,
      "scout",
      "system",
      `  · [${r.role}/p${r.priority}] ${r.text || "(link)"} → ${r.href}`,
    );
  }

  await writeFile(
    ctx.folderPath,
    "routes.md",
    `# Discovered routes (scout)\n\nSource: ${url}\nLanguage: ${plan.siteLanguage}\n\n${plan.notes ? `Note: ${plan.notes}\n\n` : ""}${plan.routes
      .map(
        (r) =>
          `- **${r.role}** (p${r.priority}) [${r.text || r.href}](${r.href}) — ${r.reason}`,
      )
      .join("\n")}\n\n## Path guesses\n${
      plan.pathGuesses.map((p) => `- \`${p}\``).join("\n") || "- (none)"
    }\n`,
  );

  const pages: DiscoveredPage[] = [home];
  const visited = new Set([home.url.replace(/\/$/, "")]);

  for (const r of plan.routes.slice(0, 8)) {
    throwIfCanceled(jobId);
    const key = r.href.replace(/\/$/, "");
    if (visited.has(key)) continue;
    visited.add(key);
    speak(jobId, "scout", "think", `Visit (${r.role}): ${r.href}`);
    pages.push(await fetchPage(jobId, r.href));
  }

  for (const pathGuess of plan.pathGuesses) {
    throwIfCanceled(jobId);
    try {
      const guess = new URL(pathGuess, url).toString();
      const key = guess.replace(/\/$/, "");
      if (visited.has(key)) continue;
      speak(jobId, "scout", "think", `Trying path: ${guess}`);
      const page = await fetchPage(jobId, guess);
      if (page.text.length > 80) {
        visited.add(key);
        pages.push(page);
      }
    } catch (err) {
      if (err instanceof JobCanceledError) throw err;
      /* ignore */
    }
  }
  ctx.pages = pages;
  throwIfCanceled(jobId);

  const nameRaw = await askLlm(
    jobId,
    `Identify the TARGET entity that OWNS this exact URL. The user gave this URL as the research/application target.

HARD RULES:
- Target = the organization, product brand, or person whose site this is (hostname authority).
- NEVER pick an employer, client, partner, or project company merely mentioned on the page (e.g. work history on a personal portfolio).
- If this is a personal portfolio / CV / candidate site, use the person's brand/name that matches the hostname — not their past employers.
- External companies named in the copy are NOT the target.
- Prefer a short display name that clearly matches the hostname "${host}" (e.g. host janedoe.dev → "Jane" or "Jane Doe", NOT a third-party employer).

Title: ${home.title}
URL: ${url}
Hostname: ${host}
Text: ${home.text.slice(0, 3000)}
${ctx.redoFeedback.scout ? `\nPrevious reviewer note: ${ctx.redoFeedback.scout}\n` : ""}
Return ONLY JSON:
{
  "companyName": "",
  "siteKind": "employer|agency|personal_portfolio|product|other"
}`,
    "Company name…",
    "scout",
  );
  const parsed = extractJson<CompanyIdentityGuess>(nameRaw);
  const siteKinds: SiteKind[] = [
    "employer",
    "agency",
    "personal_portfolio",
    "product",
    "other",
  ];
  const guess: CompanyIdentityGuess | null = parsed?.companyName
    ? {
        companyName: String(parsed.companyName).trim(),
        siteKind: siteKinds.includes(parsed.siteKind as SiteKind)
          ? (parsed.siteKind as SiteKind)
          : "other",
      }
    : null;
  // Plain-text fallback if model ignored JSON
  const plainFallback =
    !guess && nameRaw
      ? {
          companyName: nameRaw
            .split("\n")[0]
            .replace(/^["']|["']$/g, "")
            .replace(/^companyName["'\s:]+/i, "")
            .slice(0, 80),
          siteKind: "other" as SiteKind,
        }
      : null;

  throwIfCanceled(jobId);
  const resolved = resolveCompanyName(url, guess || plainFallback, host);
  const companyName = resolved.companyName || hostBrandHint(host);
  if (resolved.usedFallback) {
    speak(
      jobId,
      "scout",
      "think",
      `name locked to URL host · rejected off-target guess "${guess?.companyName || plainFallback?.companyName || "?"}" → ${companyName}`,
    );
  }
  ctx.companyName = companyName;

  throwIfCanceled(jobId);
  const renamed = await renameCompanyFolder(ctx.folderPath, companyName);
  ctx.folderName = renamed.folderName;
  ctx.folderPath = renamed.folderPath;
  const job = getJob(jobId);
  if (job) {
    job.folderName = renamed.folderName;
    job.folderPath = renamed.folderPath;
    if (job.companyName == null) job.companyName = companyName;
  }
  // Metadata update only if already canceled (setJobStatus refuses revive → running).
  setJobStatus(jobId, "running", {
    companyName,
    folderName: renamed.folderName,
  });
  throwIfCanceled(jobId);
  speak(
    jobId,
    "scout",
    "ok",
    `ready · ${renamed.folderName}/ · ${pages.length} pages`,
  );
}
