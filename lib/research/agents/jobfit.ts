import { t } from "@/lib/i18n/t";
import { WS } from "@/lib/workspace/filenames";
import type { RunContext } from "../context";
import { askLlm, extractJson } from "../llm";
import { speak } from "../speak";
import { writeFile } from "../workspace";

export async function runJobFit(ctx: RunContext) {
  const { jobId, user } = ctx;
  speak(jobId, "jobfit", "system", "── jobfit online · CV ↔ job matching");

  if (ctx.redoFeedback.jobfit) {
    speak(jobId, "jobfit", "think", `Reviewer feedback: ${ctx.redoFeedback.jobfit}`);
  }

  const corpus = ctx.pages
    .map((p) => `### ${p.title || p.url}\nURL: ${p.url}\n${p.text.slice(0, 5000)}`)
    .join("\n\n");

  const pref = user.preferredLang || "en";

  const raw = await askLlm(
    jobId,
    `You are a JobFit specialist. Match open roles on this site to the candidate CV.
Site language may be anything.

CRITICAL LANGUAGE RULE: Write "whyFit", "notes", and any prose fields in preferred language code "${pref}". Keep job "title" as shown on the site (original wording/script).

CV:
${ctx.user.cvText.slice(0, 8000)}

Site corpus:
${corpus.slice(0, 14000)}

${ctx.redoFeedback.jobfit ? `Reviewer asked you to improve: ${ctx.redoFeedback.jobfit}\n` : ""}

Return ONLY JSON:
{
  "hasMatchingJob": boolean,
  "jobs": [{"title":"","url":"","whyFit":"","priority":1}],
  "siteLanguage": "${ctx.siteLanguage}",
  "notes": ""
}`,
    "Job–CV analysis…",
    "jobfit",
  );

  const parsed = extractJson<{
    hasMatchingJob: boolean;
    jobs: { title: string; url: string; whyFit: string; priority: number }[];
    siteLanguage: string;
    notes: string;
  }>(raw);

  ctx.jobFit = {
    hasMatchingJob: Boolean(parsed?.hasMatchingJob && parsed.jobs?.length),
    jobs: parsed?.jobs || [],
    siteLanguage: parsed?.siteLanguage || ctx.siteLanguage,
    notes: parsed?.notes || "",
  };
  ctx.siteLanguage = ctx.jobFit.siteLanguage;

  const title = t("workspaceFiles.jobLinksTitle");
  const linkLabel = t("workspaceFiles.jobLinksLink");
  const fitLabel = t("workspaceFiles.jobLinksFit");
  const notesLabel = t("workspaceFiles.jobLinksNotes");

  if (ctx.jobFit.hasMatchingJob) {
    speak(jobId, "jobfit", "ok", `${ctx.jobFit.jobs.length} matching jobs`);
    await writeFile(
      ctx.folderPath,
      WS.jobLinks,
      `# ${title}\n\n${ctx.jobFit.jobs
        .map(
          (j, i) =>
            `## ${i + 1}. ${j.title}\n- ${linkLabel}: ${j.url || ctx.url}\n- ${fitLabel}: ${j.whyFit}\n`,
        )
        .join("\n")}\n\n${notesLabel}: ${ctx.jobFit.notes || "—"}\n`,
    );
  } else {
    speak(jobId, "jobfit", "think", "No matching jobs → cold application path");
    await writeFile(
      ctx.folderPath,
      WS.jobLinks,
      `# ${title}\n\n${t("workspaceFiles.jobLinksEmpty")}\n\n${notesLabel}: ${ctx.jobFit.notes || "—"}\n`,
    );
  }
}
