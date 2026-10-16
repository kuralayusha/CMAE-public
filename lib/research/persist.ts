import fs from "fs";
import path from "path";
import { getResearchJobsDir } from "@/lib/paths";
import type { ResearchJob } from "./types";

declare global {
  // eslint-disable-next-line no-var
  var __cmaeJobsHydrated: boolean | undefined;
  // eslint-disable-next-line no-var
  var __cmaePersistTimers: Map<string, ReturnType<typeof setTimeout>> | undefined;
}

function ensureDir() {
  getResearchJobsDir();
}

function jobPath(id: string) {
  return path.join(getResearchJobsDir(), `${id}.json`);
}

export function persistJobNow(job: ResearchJob) {
  try {
    ensureDir();
    const payload = {
      ...job,
      // don't persist cancel flag as active after restart in a confusing way
    };
    fs.writeFileSync(jobPath(job.id), JSON.stringify(payload), "utf8");
  } catch (err) {
    console.error("[persistJob]", err);
  }
}

export function persistJobDebounced(job: ResearchJob, ms = 250) {
  if (!globalThis.__cmaePersistTimers) {
    globalThis.__cmaePersistTimers = new Map();
  }
  const timers = globalThis.__cmaePersistTimers;
  const prev = timers.get(job.id);
  if (prev) clearTimeout(prev);
  timers.set(
    job.id,
    setTimeout(() => {
      timers.delete(job.id);
      persistJobNow(job);
    }, ms),
  );
}

export function loadJobsFromDisk(): ResearchJob[] {
  try {
    const dir = getResearchJobsDir();
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(
            fs.readFileSync(path.join(dir, f), "utf8"),
          ) as ResearchJob;
        } catch {
          return null;
        }
      })
      .filter((j): j is ResearchJob => Boolean(j?.id));
  } catch {
    return [];
  }
}

/** Cold start: disk → memory. Dead running jobs become interrupted errors. */
export function hydrateJobsFromDisk(store: Map<string, ResearchJob>) {
  if (globalThis.__cmaeJobsHydrated) return;
  globalThis.__cmaeJobsHydrated = true;

  for (const job of loadJobsFromDisk()) {
    if (store.has(job.id)) continue;
    if (job.status === "queued" || job.status === "running") {
      job.status = "error";
      job.error = "Interrupted (server restarted) — re-run from Research if needed";
      job.cancelRequested = false;
      persistJobNow(job);
    }
    if (!job.lines) job.lines = [];
    store.set(job.id, job);
  }
}

export function listUnfinishedJobs(store: Map<string, ResearchJob>): ResearchJob[] {
  const unfinished = new Set(["queued", "running", "error"]);
  return [...store.values()]
    .filter((j) => unfinished.has(j.status))
    .sort((a, b) => {
      const live = (s: string) => (s === "running" || s === "queued" ? 0 : 1);
      const d = live(a.status) - live(b.status);
      if (d !== 0) return d;
      return b.createdAt - a.createdAt;
    });
}

/** All searches (including done / canceled) — history bar */
export function listAllJobs(store: Map<string, ResearchJob>): ResearchJob[] {
  return [...store.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Wipe persisted search jobs + in-memory map (fresh install). */
export function clearAllResearchJobs(): void {
  if (globalThis.__cmaePersistTimers) {
    for (const t of globalThis.__cmaePersistTimers.values()) clearTimeout(t);
    globalThis.__cmaePersistTimers.clear();
  }
  if (globalThis.__cmaeResearchJobs) {
    globalThis.__cmaeResearchJobs.clear();
  }
  globalThis.__cmaeJobsHydrated = false;

  try {
    const dir = getResearchJobsDir();
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}
