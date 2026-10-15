import {
  fetchPage,
  planRoutesWithAi,
  type DiscoveredPage,
} from "../discover";
import type { RunContext } from "../context";
import { askLlm } from "../llm";
import { speak } from "../speak";
import { getJob, setJobStatus } from "../events";
import { createCompanyFolder, renameCompanyFolder, writeFile } from "../workspace";

export async function runScout(ctx: RunContext) {
  const { jobId, url } = ctx;
  speak(jobId, "scout", "system", "── scout online · discovery & route plan");

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
  ctx.home = home;

  const plan = await planRoutesWithAi(jobId, url, home);
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
    const key = r.href.replace(/\/$/, "");
    if (visited.has(key)) continue;
    visited.add(key);
    speak(jobId, "scout", "think", `Visit (${r.role}): ${r.href}`);
    pages.push(await fetchPage(jobId, r.href));
  }

  for (const pathGuess of plan.pathGuesses) {
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
    } catch {
      /* ignore */
    }
  }
  ctx.pages = pages;

  const nameRaw = await askLlm(
    jobId,
    `Extract the company/organization name. Reply ONLY the name.\n\nTitle: ${home.title}\nURL: ${url}\nText: ${home.text.slice(0, 3000)}${
      ctx.redoFeedback.scout ? `\n\nPrevious reviewer note: ${ctx.redoFeedback.scout}` : ""
    }`,
    "Company name…",
    "scout",
  );
  const companyName =
    nameRaw.split("\n")[0].replace(/^["']|["']$/g, "").slice(0, 80) || host;
  ctx.companyName = companyName;

  const renamed = await renameCompanyFolder(ctx.folderPath, companyName);
  ctx.folderName = renamed.folderName;
  ctx.folderPath = renamed.folderPath;
  const job = getJob(jobId);
  if (job) {
    job.folderName = renamed.folderName;
    job.folderPath = renamed.folderPath;
  }
  setJobStatus(jobId, "running", {
    companyName,
    folderName: renamed.folderName,
  });
  speak(
    jobId,
    "scout",
    "ok",
    `ready · ${renamed.folderName}/ · ${pages.length} pages`,
  );
}
