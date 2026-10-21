import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { runContact } from "./agents/contact";
import { runJobFit } from "./agents/jobfit";
import { runResearch } from "./agents/research";
import { runReviewer } from "./agents/reviewer";
import { runScout } from "./agents/scout";
import { runWriter } from "./agents/writer";
import { clearJobAbort, resetJobAbort } from "./abort";
import { JobCanceledError, isCanceled, throwIfCanceled } from "./cancel";
import { createRunContext, type RunContext } from "./context";
import { getJob, setJobStatus } from "./events";
import { hasFolderStatusSuffix } from "./folder-status";
import { speak } from "./speak";
import { SPECIALISTS, type SpecialistId } from "./types";
import { markFolderError, writeFile } from "./workspace";
import { withUsageRunAsync } from "@/lib/ai-usage/run-context";

const PIPELINE: Exclude<SpecialistId, "reviewer">[] = [
  "scout",
  "jobfit",
  "contact",
  "research",
  "writer",
];

const MAX_REWINDS = 3;
const MAX_PER_AGENT = 2;

type StepFn = (ctx: RunContext) => Promise<void>;

const RUNNERS: Record<Exclude<SpecialistId, "reviewer">, StepFn> = {
  scout: runScout,
  jobfit: runJobFit,
  contact: runContact,
  research: runResearch,
  writer: runWriter,
};

export async function runConductor(jobId: string) {
  // One research job = one usage run (scout→writer share jobId).
  return withUsageRunAsync(jobId, () => runConductorBody(jobId));
}

async function runConductorBody(jobId: string) {
  const job = getJob(jobId);
  if (!job) return;

  resetJobAbort(jobId);
  setJobStatus(jobId, "running");
  speak(
    jobId,
    "conductor",
    "system",
    t("terminal.detail.conductorSession", {
      url: job.url,
      pipeline: SPECIALISTS.join(" → "),
    }),
    t("terminal.plain.researchStarting"),
  );

  let ctx: RunContext | null = null;

  try {
    const cfg = getDb().select().from(settings).where(eq(settings.id, 1)).get();
    const { getBestCvText } = await import("@/lib/cv/library");
    const libraryText = await getBestCvText({
      preferredLanguage: cfg?.preferredLanguage || "en",
    });
    const cvText = libraryText?.trim() || cfg?.cvText?.trim() || "";
    if (!cvText) {
      throw new Error(t("research.error.cvMissing"));
    }

    ctx = createRunContext(jobId, job.url, {
      fullName: cfg?.fullName || "Candidate",
      email: cfg?.gmailAddress || "",
      cvText,
      preferredLang: cfg?.preferredLanguage || "en",
    });

    let stepIndex = 0;
    let rewinds = 0;

    while (stepIndex < PIPELINE.length) {
      throwIfCanceled(jobId);
      const agent = PIPELINE[stepIndex];
      speak(
        jobId,
        "conductor",
        "system",
        t("terminal.detail.dispatch", {
          agent,
          step: stepIndex + 1,
          total: PIPELINE.length,
        }),
        t("terminal.plain.dispatchStep", {
          step: stepIndex + 1,
          total: PIPELINE.length,
          agent,
        }),
      );

      await RUNNERS[agent](ctx);
      throwIfCanceled(jobId);
      syncFolderFromJob(ctx);
      ctx.redoFeedback[agent] = undefined;
      stepIndex += 1;
    }

    for (;;) {
      throwIfCanceled(jobId);
      speak(
        jobId,
        "conductor",
        "system",
        t("terminal.detail.dispatchReviewer"),
        t("terminal.plain.handedWork", { agent: t("terminal.agents.reviewer") }),
      );
      const verdict = await runReviewer(ctx);
      throwIfCanceled(jobId);

      if (verdict.passed || !verdict.rewindTo) {
        speak(
          jobId,
          "conductor",
          "ok",
          t("terminal.detail.workflowComplete", {
            score: verdict.overallScore,
          }),
          t("terminal.plain.researchComplete"),
        );
        break;
      }

      if (rewinds >= MAX_REWINDS) {
        speak(
          jobId,
          "conductor",
          "think",
          t("terminal.detail.maxRewind", { max: MAX_REWINDS }),
        );
        break;
      }

      const target = verdict.rewindTo;
      const tries = (ctx.retries[target] || 0) + 1;
      ctx.retries[target] = tries;
      if (tries > MAX_PER_AGENT) {
        speak(
          jobId,
          "conductor",
          "think",
          t("terminal.detail.maxRetry", { agent: target }),
        );
        break;
      }

      rewinds += 1;
      const resumeAt = PIPELINE.indexOf(target);
      if (resumeAt < 0) break;

      ctx.redoFeedback = { ...verdict.feedback };
      speak(
        jobId,
        "conductor",
        "system",
        t("terminal.detail.rewind", { agent: target, n: rewinds }),
        t("terminal.plain.packageRejected", {
          agent: t(`terminal.agents.${target}`),
        }),
      );

      stepIndex = resumeAt;
      while (stepIndex < PIPELINE.length) {
        throwIfCanceled(jobId);
        const agent = PIPELINE[stepIndex];
        speak(
          jobId,
          "conductor",
          "system",
          t("terminal.detail.reDispatch", { agent }),
          t("terminal.plain.handedWork", {
            agent: t(`terminal.agents.${agent}`),
          }),
        );
        await RUNNERS[agent](ctx);
        throwIfCanceled(jobId);
        syncFolderFromJob(ctx);
        ctx.redoFeedback[agent] = undefined;
        stepIndex += 1;
      }
    }

    if (isCanceled(jobId)) {
      throw new JobCanceledError(jobId);
    }

    await writeFile(
      ctx.folderPath,
      "summary.md",
      `# ${ctx.companyName} — scan summary\n\n- URL: ${ctx.url}\n- Folder: ${ctx.folderName}\n- Architecture: conductor + specialists\n- Matching job: ${ctx.jobFit?.hasMatchingJob ? "yes" : "no"}\n- Email: ${ctx.primaryEmail || "—"}\n- Site language: ${ctx.siteLanguage}\n- Review: ${ctx.lastReview?.overallScore ?? "—"} / ${ctx.lastReview?.threshold ?? "—"}\n- Rewinds: ${rewinds}\n`,
    );

    setJobStatus(jobId, "done", {
      companyName: ctx.companyName,
      folderName: ctx.folderName,
    });
    speak(
      jobId,
      "conductor",
      "ok",
      t("terminal.detail.doneFolder", { folder: ctx.folderName }),
      t("terminal.plain.researchComplete"),
    );
  } catch (err) {
    if (err instanceof JobCanceledError || isCanceled(jobId)) {
      speak(
        jobId,
        "conductor",
        "err",
        t("terminal.detail.pipelineCanceled"),
        t("terminal.plain.jobCanceled"),
      );
      // Re-assert canceled if a specialist revived status to "running".
      const live = getJob(jobId);
      if (live && live.status !== "canceled") {
        live.cancelRequested = true;
        setJobStatus(jobId, "canceled", {
          folderName: live.folderName,
          error: t("research.error.canceledByUser"),
        });
      }
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    speak(
      jobId,
      "conductor",
      "err",
      t("terminal.detail.fatal", { msg: message }),
    );

    let folderName = ctx?.folderName;
    if (
      ctx?.folderPath &&
      !hasFolderStatusSuffix(folderName || ctx.folderPath)
    ) {
      try {
        const renamed = await markFolderError(ctx.folderPath);
        folderName = renamed.folderName;
        ctx.folderName = renamed.folderName;
        ctx.folderPath = renamed.folderPath;
        const liveJob = getJob(jobId);
        if (liveJob) {
          liveJob.folderName = renamed.folderName;
          liveJob.folderPath = renamed.folderPath;
        }
      } catch (renameErr) {
        speak(
          jobId,
          "conductor",
          "err",
          t("terminal.detail.folderRenameFailed", {
            msg:
              renameErr instanceof Error
                ? renameErr.message
                : String(renameErr),
          }),
        );
      }
    }

    if (isCanceled(jobId)) {
      speak(
        jobId,
        "conductor",
        "err",
        t("terminal.detail.pipelineCanceled"),
        t("terminal.plain.jobCanceled"),
      );
      return;
    }
    setJobStatus(jobId, "error", { error: message, folderName });
  } finally {
    clearJobAbort(jobId);
  }
}

function syncFolderFromJob(ctx: RunContext) {
  const job = getJob(ctx.jobId);
  if (!job) return;
  if (job.folderPath) ctx.folderPath = job.folderPath;
  if (job.folderName) ctx.folderName = job.folderName;
  if (job.companyName) ctx.companyName = job.companyName;
}
