import type { RunContext } from "../context";
import { askLlm, extractJson } from "../llm";
import { speak } from "../speak";
import { writeFile } from "../workspace";

export async function runJobFit(ctx: RunContext) {
  const { jobId } = ctx;
  speak(jobId, "jobfit", "system", "── jobfit online · CV ↔ ilan eşleşmesi");

  if (ctx.redoFeedback.jobfit) {
    speak(jobId, "jobfit", "think", `Reviewer feedback: ${ctx.redoFeedback.jobfit}`);
  }

  const corpus = ctx.pages
    .map((p) => `### ${p.title || p.url}\nURL: ${p.url}\n${p.text.slice(0, 5000)}`)
    .join("\n\n");

  const raw = await askLlm(
    jobId,
    `You are a JobFit specialist. Match open roles on this site to the candidate CV.
Site language may be anything.

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
    "İlan–CV analizi…",
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

  if (ctx.jobFit.hasMatchingJob) {
    speak(jobId, "jobfit", "ok", `${ctx.jobFit.jobs.length} uygun ilan`);
    await writeFile(
      ctx.folderPath,
      "basvuru_linkleri.md",
      `# Başvuru / ilan linkleri (jobfit)\n\n${ctx.jobFit.jobs
        .map(
          (j, i) =>
            `## ${i + 1}. ${j.title}\n- Link: ${j.url || ctx.url}\n- Uyum: ${j.whyFit}\n`,
        )
        .join("\n")}\n\nNotlar: ${ctx.jobFit.notes || "—"}\n`,
    );
  } else {
    speak(jobId, "jobfit", "think", "Uygun ilan yok → cold başvuru hattı");
    await writeFile(
      ctx.folderPath,
      "basvuru_linkleri.md",
      `# Başvuru / ilan linkleri (jobfit)\n\nUygun açık ilan yok.\nCold / inisiyatif başvuru.\n\nNotlar: ${ctx.jobFit.notes || "—"}\n`,
    );
  }
}
