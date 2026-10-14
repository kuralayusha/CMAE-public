import fs from "fs";
import path from "path";
import type { SearchJob } from "./types";

const DIR = path.join(process.cwd(), "data", "search-jobs");

declare global {
  // eslint-disable-next-line no-var
  var __cmaeJobsHydrated: boolean | undefined;
  // eslint-disable-next-line no-var
  var __cmaePersistTimers: Map<string, ReturnType<typeof setTimeout>> | undefined;
}

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

function jobPath(id: string) {
  return path.join(DIR, `${id}.json`);
}

export function persistJobNow(job: SearchJob) {
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

export function persistJobDebounced(job: SearchJob, ms = 250) {
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

export function loadJobsFromDisk(): SearchJob[] {
  try {
    ensureDir();
    return fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) as SearchJob;
        } catch {
          return null;
        }
      })
      .filter((j): j is SearchJob => Boolean(j?.id));
  } catch {
    return [];
  }
}

/** Cold start: disk → memory. Dead running jobs become interrupted errors. */
export function hydrateJobsFromDisk(store: Map<string, SearchJob>) {
  if (globalThis.__cmaeJobsHydrated) return;
  globalThis.__cmaeJobsHydrated = true;

  for (const job of loadJobsFromDisk()) {
    if (store.has(job.id)) continue;
    if (job.status === "queued" || job.status === "running") {
      job.status = "error";
      job.error = "Interrupted (server restarted) — re-run from Search if needed";
      job.cancelRequested = false;
      persistJobNow(job);
    }
    if (!job.lines) job.lines = [];
    store.set(job.id, job);
  }
}

export function listUnfinishedJobs(store: Map<string, SearchJob>): SearchJob[] {
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

/** Tüm araştırmalar (done / canceled dahil) — history bar */
export function listAllJobs(store: Map<string, SearchJob>): SearchJob[] {
  return [...store.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Wipe persisted search jobs + in-memory map (fresh install). */
export function clearAllSearchJobs(): void {
  if (globalThis.__cmaePersistTimers) {
    for (const t of globalThis.__cmaePersistTimers.values()) clearTimeout(t);
    globalThis.__cmaePersistTimers.clear();
  }
  if (globalThis.__cmaeSearchJobs) {
    globalThis.__cmaeSearchJobs.clear();
  }
  globalThis.__cmaeJobsHydrated = false;

  try {
    if (!fs.existsSync(DIR)) return;
    for (const name of fs.readdirSync(DIR)) {
      try {
        fs.unlinkSync(path.join(DIR, name));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}
