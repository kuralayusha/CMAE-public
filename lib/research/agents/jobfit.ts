import { t } from "@/lib/i18n/t";
import { WS } from "@/lib/workspace/filenames";
import { throwIfCanceled } from "../cancel";
import type { JobFitJob, RunContext } from "../context";
import { askLlm, extractJson } from "../llm";
import { speak } from "../speak";
import { writeFile } from "../workspace";

/** Minimum fitScore to treat a posting as a real CV match. */
export const JOB_FIT_MIN_SCORE = 70;

const WEAK_FIT_RE =
  /\b(poor\s+fit|weak\s+fit|not\s+a\s+(good\s+)?match|unlikely|does\s+not\s+align|no\s+align|mismatch|unsuitable|nicht\s+geeignet|kein\s+fit|schlecht(er)?\s+fit|uygun\s+de[gğ]il)\b/i;

/**
 * Keep only roles that are genuine CV matches. Weak / explanatory listings
 * belong in notes, never in the jobs array the writer can cite.
 */
export function normalizeJobFitJobs(
  jobs: Array<Partial<JobFitJob> | null | undefined> | null | undefined,
): JobFitJob[] {
  const out: JobFitJob[] = [];
  for (const raw of jobs || []) {
    if (!raw) continue;
    const title = String(raw.title || "").trim();
    if (!title) continue;
    const whyFit = String(raw.whyFit || "").trim();
    if (WEAK_FIT_RE.test(whyFit) || WEAK_FIT_RE.test(title)) continue;
    const fitScore =
      typeof raw.fitScore === "number" && Number.isFinite(raw.fitScore)
        ? Math.max(0, Math.min(100, Math.round(raw.fitScore)))
        : undefined;
    if (fitScore != null && fitScore < JOB_FIT_MIN_SCORE) continue;
    // No score from the model → still require a substantive whyFit; prefer omit.
    if (fitScore == null && whyFit.length < 40) continue;
    out.push({
      title,
      url: String(raw.url || "").trim(),
      whyFit,
      priority: Number.isFinite(Number(raw.priority))
        ? Math.max(1, Math.round(Number(raw.priority)))
        : out.length + 1,
      fitScore,
    });
  }
  out.sort(
    (a, b) =>
      (b.fitScore ?? 0) - (a.fitScore ?? 0) || a.priority - b.priority,
  );
  return out.slice(0, 3);
}

const JOB_FIT_MATCH_RULES = `
MATCH RULES (strict — false positives hurt the candidate):

Only put a role in "jobs" when ALL of the following are true:
1) Same job family as the CV's primary work (e.g. software/frontend/fullstack engineering ↔ software/frontend/fullstack). Adjacent titles OK only if the day-to-day work is clearly the same craft.
2) Core skills overlap: the posting needs tools/stack/domain the CV actually shows (not "willing to learn" or vague transferables).
3) Seniority is compatible (senior CV ≠ Werkstudent/Praktikant/junior-only; junior CV ≠ Staff/Principal-only).
4) fitScore ≥ ${JOB_FIT_MIN_SCORE} (0–100). Be honest — 50–69 is NOT a match.

NEVER put in "jobs" (put explanation in "notes" instead):
- Sales, field sales, HR, recruiting, finance, legal, auditing, regulatory/certification experts, facility/TGA, stage/event technicians, pure product-manager roles that require unrelated domain mastery, trades, nursing, etc. when the CV is software engineering (and the reverse).
- Roles whose required certification/degree the CV lacks (Meister, MDR auditor, Energietechnik + Python-only PM, …).
- Blog posts, partner logos, or third-party job boards that are not openings on THIS site.
- "Initiativbewerbung" / speculative inbox with no defined role — that is cold outreach, not a match.
- Stretch / "could maybe fit with upskilling" ideas.

If nothing clears the bar: hasMatchingJob=false, jobs=[], and explain rejected openings briefly in notes.
`.trim();

export async function runJobFit(ctx: RunContext) {
  const { jobId, user } = ctx;
  speak(
    jobId,
    "jobfit",
    "system",
    t("terminal.detail.jobfitOnline"),
    t("terminal.plain.startedTask"),
  );
  throwIfCanceled(jobId);

  if (ctx.redoFeedback.jobfit) {
    speak(
      jobId,
      "jobfit",
      "think",
      t("terminal.detail.reviewerFeedback", { msg: ctx.redoFeedback.jobfit }),
    );
  }

  const corpus = ctx.pages
    .map((p) => `### ${p.title || p.url}\nURL: ${p.url}\n${p.text.slice(0, 5000)}`)
    .join("\n\n");

  const pref = user.preferredLang || "en";

  const raw = await askLlm(
    jobId,
    "research.jobfit",
    `You are a JobFit specialist. Decide which open roles on THIS site are a REAL match for the candidate CV — not "interesting" or "stretch".

Target site URL: ${ctx.url} — only roles published on THIS site. Do not invent jobs at other companies mentioned in the page copy.

Site language may be anything.

CRITICAL LANGUAGE RULE: Write "whyFit", "notes", and any prose fields in preferred language code "${pref}". Keep job "title" as shown on the site (original wording/script).

${JOB_FIT_MATCH_RULES}

CV:
${ctx.user.cvText.slice(0, 8000)}

Site corpus:
${corpus.slice(0, 14000)}

${ctx.redoFeedback.jobfit ? `Reviewer asked you to improve: ${ctx.redoFeedback.jobfit}\n` : ""}

Return ONLY JSON:
{
  "hasMatchingJob": boolean,
  "jobs": [{"title":"","url":"","whyFit":"","priority":1,"fitScore":0}],
  "siteLanguage": "${ctx.siteLanguage}",
  "notes": ""
}`,
    t("terminal.llm.jobFit"),
    "jobfit",
  );

  const parsed = extractJson<{
    hasMatchingJob: boolean;
    jobs: JobFitJob[];
    siteLanguage: string;
    notes: string;
  }>(raw);

  const jobs = normalizeJobFitJobs(parsed?.jobs);
  ctx.jobFit = {
    hasMatchingJob: jobs.length > 0,
    jobs,
    siteLanguage: parsed?.siteLanguage || ctx.siteLanguage,
    notes: parsed?.notes || "",
  };
  ctx.siteLanguage = ctx.jobFit.siteLanguage;

  const title = t("workspaceFiles.jobLinksTitle");
  const linkLabel = t("workspaceFiles.jobLinksLink");
  const fitLabel = t("workspaceFiles.jobLinksFit");
  const notesLabel = t("workspaceFiles.jobLinksNotes");

  if (ctx.jobFit.hasMatchingJob) {
    speak(
      jobId,
      "jobfit",
      "ok",
      t("terminal.detail.matchingJobs", { count: ctx.jobFit.jobs.length }),
      t("terminal.plain.matchingJobs", { count: ctx.jobFit.jobs.length }),
    );
    await writeFile(
      ctx.folderPath,
      WS.jobLinks,
      `# ${title}\n\n${ctx.jobFit.jobs
        .map(
          (j, i) =>
            `## ${i + 1}. ${j.title}\n- ${linkLabel}: ${j.url || ctx.url}\n- ${fitLabel}: ${j.whyFit}${
              j.fitScore != null ? ` (score ${j.fitScore})` : ""
            }\n`,
        )
        .join("\n")}\n\n${notesLabel}: ${ctx.jobFit.notes || "—"}\n`,
    );
  } else {
    speak(
      jobId,
      "jobfit",
      "think",
      t("terminal.detail.noMatchingJobs"),
      t("terminal.plain.noMatchingJobs"),
    );
    await writeFile(
      ctx.folderPath,
      WS.jobLinks,
      `# ${title}\n\n${t("workspaceFiles.jobLinksEmpty")}\n\n${notesLabel}: ${ctx.jobFit.notes || "—"}\n`,
    );
  }
}
