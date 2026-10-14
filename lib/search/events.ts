import { EventEmitter } from "events";
import { hydrateJobsFromDisk, persistJobDebounced, persistJobNow } from "./persist";
import type { JobEvent, SearchJob, TermKind, TermLine } from "./types";

declare global {
  // eslint-disable-next-line no-var
  var __cmaeSearchBus: EventEmitter | undefined;
  // eslint-disable-next-line no-var
  var __cmaeSearchJobs: Map<string, SearchJob> | undefined;
}

export function getJobBus(): EventEmitter {
  if (!globalThis.__cmaeSearchBus) {
    globalThis.__cmaeSearchBus = new EventEmitter();
    globalThis.__cmaeSearchBus.setMaxListeners(100);
  }
  return globalThis.__cmaeSearchBus;
}

export function getJobs(): Map<string, SearchJob> {
  if (!globalThis.__cmaeSearchJobs) {
    globalThis.__cmaeSearchJobs = new Map();
  }
  hydrateJobsFromDisk(globalThis.__cmaeSearchJobs);
  return globalThis.__cmaeSearchJobs;
}

export function getJob(id: string): SearchJob | undefined {
  return getJobs().get(id);
}

let lineSeq = 0;

export function emitLine(
  jobId: string,
  kind: TermKind,
  text: string,
  agent?: TermLine["agent"],
  plain?: string,
) {
  const job = getJob(jobId);
  if (!job) return;
  const line: TermLine = {
    id: `${jobId}-${++lineSeq}`,
    kind,
    text,
    plain,
    at: Date.now(),
    agent,
  };
  job.lines.push(line);
  // keep memory bounded
  if (job.lines.length > 800) job.lines.splice(0, job.lines.length - 800);
  persistJobDebounced(job);
  const event: JobEvent = { type: "line", line };
  getJobBus().emit(`job:${jobId}`, event);
}

export function setJobStatus(
  jobId: string,
  status: SearchJob["status"],
  extra?: {
    companyName?: string | null;
    error?: string | null;
    folderName?: string;
  },
) {
  const job = getJob(jobId);
  if (!job) return;
  job.status = status;
  if (extra?.companyName !== undefined) job.companyName = extra.companyName;
  if (extra?.error !== undefined) job.error = extra.error;
  if (extra?.folderName !== undefined) job.folderName = extra.folderName;
  persistJobNow(job);
  getJobBus().emit(`job:${jobId}`, {
    type: "status",
    status,
    companyName: job.companyName,
    error: job.error,
    folderName: job.folderName,
  } as JobEvent);
  if (status === "done" || status === "error" || status === "canceled") {
    getJobBus().emit(`job:${jobId}`, { type: "done", status } satisfies JobEvent);
  }

  // Search bitti → tracker’a light merge (IMAP/AI yok); tracker sayfası SSE ile yenilenir
  if (status === "done") {
    void Promise.resolve()
      .then(async () => {
        const { mergeSearchJobIntoTracker } = await import(
          "@/lib/tracker/light-merge"
        );
        const result = mergeSearchJobIntoTracker(jobId);
        if (!result.ok) {
          console.warn(
            `[tracker/light-merge] ${jobId}: ${result.reason || result.action}`,
          );
        }
      })
      .catch((err) => {
        console.error("[tracker/light-merge]", err);
      });
  }
}
