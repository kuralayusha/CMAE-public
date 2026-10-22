import { t } from "@/lib/i18n/t";
import { abortJob, getJobSignal } from "./abort";
import { emitLine, getJob, setJobStatus } from "./events";
import {
  folderStatusSuffix,
  hasFolderStatusSuffix,
} from "./folder-status";
import { markFolderCanceled } from "./workspace";

export class JobCanceledError extends Error {
  constructor(jobId: string) {
    super(`Job canceled: ${jobId}`);
    this.name = "JobCanceledError";
  }
}

export function isCanceled(jobId: string): boolean {
  const job = getJob(jobId);
  return Boolean(job?.cancelRequested) || job?.status === "canceled";
}

export function throwIfCanceled(jobId: string) {
  if (isCanceled(jobId)) {
    throw new JobCanceledError(jobId);
  }
}

/** Reject as soon as the job abort signal fires (or if already aborted). */
export function whenJobAborted(jobId: string): Promise<never> {
  const signal = getJobSignal(jobId);
  if (!signal) {
    return new Promise(() => {
      /* never — no controller yet */
    });
  }
  if (signal.aborted) {
    return Promise.reject(new JobCanceledError(jobId));
  }
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new JobCanceledError(jobId)),
      { once: true },
    );
  });
}

export async function cancelJob(jobId: string): Promise<{
  folderName: string | null;
}> {
  const job = getJob(jobId);
  if (!job) {
    throw new Error(t("research.error.jobNotFound"));
  }

  // Idempotent: already fully canceled — don't spam logs / re-rename.
  if (job.status === "canceled" && job.cancelRequested) {
    return { folderName: job.folderName };
  }

  job.cancelRequested = true;
  abortJob(jobId);
  emitLine(
    jobId,
    "err",
    t("terminal.detail.cancelRequested"),
    undefined,
    t("terminal.plain.jobCanceled"),
  );

  let folderName = job.folderName;
  let folderPath = job.folderPath;

  if (folderPath && !hasFolderStatusSuffix(folderName || pathBasename(folderPath))) {
    try {
      const renamed = await markFolderCanceled(folderPath);
      folderName = renamed.folderName;
      folderPath = renamed.folderPath;
      job.folderName = folderName;
      job.folderPath = folderPath;
    } catch (err) {
      emitLine(
        jobId,
        "err",
        t("terminal.detail.folderRenameFailed", {
          msg: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  } else if (folderName && !hasFolderStatusSuffix(folderName)) {
    const suffix = folderStatusSuffix("canceled");
    folderName = suffix ? `${folderName} ${suffix}` : folderName;
    job.folderName = folderName;
  }

  setJobStatus(jobId, "canceled", {
    folderName,
    error: t("research.error.canceledByUser"),
  });
  emitLine(
    jobId,
    "system",
    t("terminal.detail.canceledFolder", { folder: folderName }),
  );

  return { folderName };
}

function pathBasename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}
