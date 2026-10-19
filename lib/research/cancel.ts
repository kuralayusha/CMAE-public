import { t } from "@/lib/i18n/t";
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

export async function cancelJob(jobId: string): Promise<{
  folderName: string | null;
}> {
  const job = getJob(jobId);
  if (!job) {
    throw new Error("Job not found");
  }

  job.cancelRequested = true;
  emitLine(jobId, "err", "[conductor] CANCEL requested by user — killing specialists…");

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
        `Folder rename failed: ${err instanceof Error ? err.message : String(err)}`,
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
  emitLine(jobId, "system", `[conductor] stopped · folder → ${folderName}`);

  return { folderName };
}

function pathBasename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}
