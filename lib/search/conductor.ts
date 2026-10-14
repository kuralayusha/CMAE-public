import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { runContact } from "./agents/contact";
import { runJobFit } from "./agents/jobfit";
import { runResearch } from "./agents/research";
import { runReviewer } from "./agents/reviewer";
import { runScout } from "./agents/scout";
import { runWriter } from "./agents/writer";
import { JobCanceledError, isCanceled, throwIfCanceled } from "./cancel";
import { createRunContext, type RunContext } from "./context";
import { getJob, setJobStatus } from "./events";
import { speak } from "./speak";
import { SPECIALISTS, type SpecialistId } from "./types";
import { writeFile } from "./workspace";

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
  const job = getJob(jobId);
  if (!job) return;

  setJobStatus(jobId, "running");
  speak(
    jobId,
    "conductor",
    "system",
    `◆ conductor · ${job.url} · specialists: ${SPECIALISTS.join(" → ")}`,
    "Araştırma başlıyor; uzman adımlar sırayla işleyecek: keşif → ilan → iletişim → araştırma → yazım → kontrol",
  );

  try {
    const cfg = getDb().select().from(settings).where(eq(settings.id, 1)).get();
    const { getBestCvText } = await import("@/lib/cv/library");
    const libraryText = await getBestCvText({
      preferredLanguage: cfg?.preferredLanguage || "tr",
    });
    const cvText = libraryText?.trim() || cfg?.cvText?.trim() || "";
    if (!cvText) {
      throw new Error(
        "CV bulunamadı — Ayarlar’dan CV yükleyin veya workspace/cvs/ klasörüne PDF bırakın",
      );
    }

    const ctx = createRunContext(jobId, job.url, {
      fullName: cfg?.fullName || "Aday",
      email: cfg?.gmailAddress || "",
      cvText,
      preferredLang: cfg?.preferredLanguage || "tr",
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
        `▶ dispatch → ${agent} (step ${stepIndex + 1}/${PIPELINE.length})`,
        `Sıra ${stepIndex + 1}/${PIPELINE.length}: iş ${agent} adımına geçildi`,
      );

      await RUNNERS[agent](ctx);
      throwIfCanceled(jobId);
      syncFolderFromJob(ctx);
      ctx.redoFeedback[agent] = undefined;
      stepIndex += 1;
    }

    for (;;) {
      throwIfCanceled(jobId);
      speak(jobId, "conductor", "system", "▶ dispatch → reviewer");
      const verdict = await runReviewer(ctx);
      throwIfCanceled(jobId);

      if (verdict.passed || !verdict.rewindTo) {
        speak(
          jobId,
          "conductor",
          "ok",
          `workflow complete · score ${verdict.overallScore}`,
        );
        break;
      }

      if (rewinds >= MAX_REWINDS) {
        speak(
          jobId,
          "conductor",
          "think",
          `max rewind (${MAX_REWINDS}) aşıldı — mevcut paketle devam`,
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
          `${target} için max retry — paket kilitleniyor`,
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
        `⏪ REWIND → ${target} (rewind #${rewinds})`,
      );

      stepIndex = resumeAt;
      while (stepIndex < PIPELINE.length) {
        throwIfCanceled(jobId);
        const agent = PIPELINE[stepIndex];
        speak(jobId, "conductor", "system", `▶ re-dispatch → ${agent}`);
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
      "ozet.md",
      `# ${ctx.companyName} — tarama özeti\n\n- URL: ${ctx.url}\n- Klasör: ${ctx.folderName}\n- Mimari: conductor + specialists\n- Uygun ilan: ${ctx.jobFit?.hasMatchingJob ? "evet" : "hayır"}\n- E-posta: ${ctx.primaryEmail || "—"}\n- Site dili: ${ctx.siteLanguage}\n- Review: ${ctx.lastReview?.overallScore ?? "—"} / ${ctx.lastReview?.threshold ?? "—"}\n- Rewinds: ${rewinds}\n`,
    );

    setJobStatus(jobId, "done", {
      companyName: ctx.companyName,
      folderName: ctx.folderName,
    });
    speak(jobId, "conductor", "ok", `done · ${ctx.folderName}/`);
  } catch (err) {
    if (err instanceof JobCanceledError || isCanceled(jobId)) {
      // cancelJob already set status + renamed folder
      speak(jobId, "conductor", "err", "pipeline aborted (canceled)");
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    speak(jobId, "conductor", "err", `FATAL: ${message}`);
    setJobStatus(jobId, "error", { error: message });
  }
}

function syncFolderFromJob(ctx: RunContext) {
  const job = getJob(ctx.jobId);
  if (!job) return;
  if (job.folderPath) ctx.folderPath = job.folderPath;
  if (job.folderName) ctx.folderName = job.folderName;
  if (job.companyName) ctx.companyName = job.companyName;
}
