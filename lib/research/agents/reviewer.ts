import { t } from "@/lib/i18n/t";
import { throwIfCanceled } from "../cancel";
import type { RunContext } from "../context";
import { askLlm, extractJson } from "../llm";
import { speak } from "../speak";
import type { ReviewVerdict, SpecialistId } from "../types";
import { writeFile } from "../workspace";

const THRESHOLD = 72;
const REDOABLE = ["scout", "jobfit", "contact", "research", "writer"] as const;

export async function runReviewer(ctx: RunContext): Promise<ReviewVerdict> {
  const { jobId } = ctx;
  speak(
    jobId,
    "reviewer",
    "system",
    t("terminal.detail.reviewerOnline"),
    t("terminal.plain.startedTask"),
  );
  throwIfCanceled(jobId);

  const packageBrief = `
Company: ${ctx.companyName}
URL: ${ctx.url}
Site language: ${ctx.siteLanguage}
Primary email: ${ctx.primaryEmail || "none"}
JobFit: ${ctx.jobFit?.hasMatchingJob ? "has jobs" : "cold"} · ${JSON.stringify(ctx.jobFit?.jobs || []).slice(0, 1500)}
Emails: ${ctx.emails
    .slice(0, 8)
    .map((e) => e.email)
    .join(", ")}
Routes count: ${ctx.routes.length}
Research (excerpt):
${ctx.researchMd.slice(0, 2500)}

Draft site-lang:
${ctx.draftSite.slice(0, 2000)}

Draft preferred (${ctx.user.preferredLang}):
${ctx.draftPreferred.slice(0, 2000)}

CV excerpt:
${ctx.user.cvText.slice(0, 2000)}
`;

  const raw = await askLlm(
    jobId,
    "research.reviewer",
    `You are a strict Application Package Reviewer.
Score each specialist 0-100 and overall 0-100.
Pass threshold = ${THRESHOLD}.

TARGET LOCK: The user-given URL is the only application/research target. Company name must identify the entity that owns that URL. Never pass a package that pivoted to a different company merely mentioned on the page (e.g. researching an employer found on a personal portfolio). External research may enrich the same target only.

Check:
- scout: useful pages found? company name matches the given URL host (HARD FAIL / rewindTo=scout if name is a different organization than the URL owner)?
- jobfit: every listed job a REAL CV match (same job family + core skills + seniority)? Weak/stretch/unrelated openings must NOT be in jobs[] (notes only). Cold path when nothing fits. (only roles on the target site)
- contact: best email for hiring at the TARGET company (careers > generic)? Do NOT demand emails for a different company/domain than the given URL.
- research: concrete, non-hallucinated, about the TARGET URL entity only, useful for personalization?
- writer: email matches CV + research + job/cold intent for the TARGET company? correct language? no fake claims? tone?
- writer craft quality (penalize heavily if missing):
  · length ~100–150 words (fail if clearly over ~200 or padded fluff)
  · 3–4 short paragraphs, scannable in ~10–15 seconds
  · subject short/specific (≤8 words); not vague ("Hello", "Job application", "İş başvurusu", "Merhaba")
  · body order: greeting → who/what → value (1–2 wins, preferably quantified from CV) → why this company (research-specific) → open close + CV attached mention
  · personalized to this company (not copy-paste generic); clear target role/field (not "any position")
  · professional-warm tone; company name spelled correctly; plain text only
- writer HARD FAIL (score writer ≤ 40 and rewindTo=writer) if SUBJECT/BODY contain notes, TODOs, placeholders ([…], TBD, N/A, "unknown", "bulunamadı"), meta comments, or explanations about missing info. SUBJECT+BODY must be paste-ready for Gmail draft — no agent chatter inside the mail fields. Missing facts must be omitted, never annotated.
- writer HARD FAIL (score writer ≤ 35 and rewindTo=writer) if the mail applies for / names a specific open vacancy that is NOT in JobFit's matched jobs list, OR applies for a role clearly outside the CV's job family (e.g. sales/HR/auditor/stage tech when CV is software engineering). Cold mails must target the CV field, not an unmatched posting.
- jobfit HARD FAIL (score jobfit ≤ 40 and rewindTo=jobfit) if jobs[] includes roles that are clearly not CV matches (wrong family, missing required certs/stack, junior-only for senior CV, etc.).

If overall < ${THRESHOLD} OR writer < ${THRESHOLD}, set rewindTo to the WEAKEST specialist that would most improve the package (usually writer, sometimes research/contact/jobfit/scout).
If all good, rewindTo = null and passed = true.

Return ONLY JSON:
{
  "passed": boolean,
  "overallScore": number,
  "threshold": ${THRESHOLD},
  "scores": { "scout": 0, "jobfit": 0, "contact": 0, "research": 0, "writer": 0 },
  "rewindTo": "scout"|"jobfit"|"contact"|"research"|"writer"|null,
  "feedback": {
    "scout": "",
    "jobfit": "",
    "contact": "",
    "research": "",
    "writer": ""
  },
  "summary": "English short verdict"
}

Package:
${packageBrief}`,
    t("terminal.llm.scoring"),
    "reviewer",
  );

  const parsed = extractJson<ReviewVerdict>(raw);
  const verdict = normalizeVerdict(parsed);

  ctx.lastReview = verdict;
  speak(
    jobId,
    "reviewer",
    verdict.passed ? "ok" : "think",
    verdict.passed
      ? t("terminal.detail.reviewScorePass", {
          score: verdict.overallScore,
          threshold: verdict.threshold,
        })
      : t("terminal.detail.reviewScoreRewind", {
          score: verdict.overallScore,
          threshold: verdict.threshold,
          agent: verdict.rewindTo || "",
        }),
    t("terminal.plain.scoringPackage"),
  );
  if (verdict.summary) {
    speak(jobId, "reviewer", "think", verdict.summary);
  }
  if (verdict.rewindTo && verdict.feedback[verdict.rewindTo]) {
    speak(
      jobId,
      "reviewer",
      "think",
      t("terminal.detail.reviewFeedback", {
        agent: verdict.rewindTo,
        msg: verdict.feedback[verdict.rewindTo],
      }),
    );
  }

  await writeFile(
    ctx.folderPath,
    "review.md",
    `# Reviewer\n\n- Overall: **${verdict.overallScore}** / ${verdict.threshold}\n- Passed: ${verdict.passed}\n- Rewind: ${verdict.rewindTo || "—"}\n\n## Scores\n${Object.entries(
      verdict.scores,
    )
      .map(([k, v]) => `- ${k}: ${v}`)
      .join("\n")}\n\n## Feedback\n${Object.entries(verdict.feedback)
      .filter(([, v]) => v)
      .map(([k, v]) => `### ${k}\n${v}`)
      .join("\n\n")}\n\n## Summary\n${verdict.summary}\n`,
  );

  return verdict;
}

function normalizeVerdict(parsed: ReviewVerdict | null): ReviewVerdict {
  const scores = {
    scout: clamp(parsed?.scores?.scout ?? 0),
    jobfit: clamp(parsed?.scores?.jobfit ?? 0),
    contact: clamp(parsed?.scores?.contact ?? 0),
    research: clamp(parsed?.scores?.research ?? 0),
    writer: clamp(parsed?.scores?.writer ?? 0),
  };
  let overall = clamp(
    parsed?.overallScore ??
      Math.round(
        (scores.scout +
          scores.jobfit +
          scores.contact +
          scores.research +
          scores.writer) /
          5,
      ),
  );
  let rewindTo = parsed?.rewindTo ?? null;
  if (rewindTo && !REDOABLE.includes(rewindTo)) rewindTo = null;

  let passed = Boolean(parsed?.passed) && overall >= THRESHOLD && !rewindTo;
  if (overall < THRESHOLD && !rewindTo) {
    // pick weakest
    const weakest = (Object.entries(scores) as [Exclude<SpecialistId, "reviewer">, number][])
      .sort((a, b) => a[1] - b[1])[0]?.[0];
    rewindTo = weakest || "writer";
    passed = false;
  }
  if (passed) rewindTo = null;

  return {
    passed,
    overallScore: overall,
    threshold: THRESHOLD,
    scores,
    rewindTo,
    feedback: parsed?.feedback || {},
    summary: parsed?.summary || "",
  };
}

function clamp(n: number) {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
