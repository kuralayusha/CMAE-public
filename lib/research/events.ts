import { EventEmitter } from "events";
import { hydrateJobsFromDisk, persistJobDebounced, persistJobNow } from "./persist";
import type { JobEvent, ResearchJob, TermKind, TermLine } from "./types";

declare global {
  // eslint-disable-next-line no-var
  var __cmaeSearchBus: EventEmitter | undefined;
  // eslint-disable-next-line no-var
  var __cmaeResearchJobs: Map<string, ResearchJob> | undefined;
}

export function getJobBus(): EventEmitter {
  if (!globalThis.__cmaeSearchBus) {
    globalThis.__cmaeSearchBus = new EventEmitter();
    globalThis.__cmaeSearchBus.setMaxListeners(100);
  }
  return globalThis.__cmaeSearchBus;
}

export function getJobs(): Map<string, ResearchJob> {
  if (!globalThis.__cmaeResearchJobs) {
    globalThis.__cmaeResearchJobs = new Map();
  }
  hydrateJobsFromDisk(globalThis.__cmaeResearchJobs);
  return globalThis.__cmaeResearchJobs;
}

export function getJob(id: string): ResearchJob | undefined {
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
  status: ResearchJob["status"],
  extra?: {
    companyName?: string | null;
    error?: string | null;
    folderName?: string;
  },
) {
  const job = getJob(jobId);
  if (!job) return;

  // Cancel/done race: scout used to call setJobStatus(..., "running") at the
  // end and revive an already-canceled job — UI stayed "live" until a 2nd cancel.
  const terminal = job.status === "canceled" || job.status === "done";
  if (terminal && (status === "running" || status === "queued")) {
    if (extra?.companyName !== undefined) job.companyName = extra.companyName;
    if (extra?.folderName !== undefined) job.folderName = extra.folderName;
    persistJobNow(job);
    getJobBus().emit(`job:${jobId}`, {
      type: "status",
      status: job.status,
      companyName: job.companyName,
      error: job.error,
      folderName: job.folderName,
    } as JobEvent);
    return;
  }

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

  // Research finished → light merge into tracker (no IMAP/AI); tracker page refreshes via SSE
  if (status === "done") {
    void Promise.resolve()
      .then(async () => {
        const { mergeResearchJobIntoTracker } = await import(
          "@/lib/tracker/light-merge"
        );
        const result = mergeResearchJobIntoTracker(jobId);
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
