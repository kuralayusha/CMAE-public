import { randomUUID } from "crypto";
import { runSearchAgent } from "./agent";
import { getJobs } from "./events";
import { stripFolderStatusSuffix } from "./folder-status";
import { listAllJobs, listUnfinishedJobs, persistJobNow } from "./persist";
import type { ResearchJob } from "./types";

export type JobUiRow = {
  id: string;
  url: string;
  status: ResearchJob["status"];
  folderName: string;
  companyName: string | null;
  error: string | null;
  createdAt: number;
  displayName: string;
};

function toUiRow(j: ResearchJob): JobUiRow {
  const host = (() => {
    try {
      return new URL(j.url).hostname.replace(/^www\./, "");
    } catch {
      return j.url;
    }
  })();
  const raw =
    j.companyName ||
    (j.folderName !== "(pending)" ? j.folderName : host) ||
    host;
  const displayName =
    stripFolderStatusSuffix(raw)
      .replace(/^\d+\s*-\s*/, "")
      .trim() || raw;
  return {
    id: j.id,
    url: j.url,
    status: j.status,
    folderName: j.folderName,
    companyName: j.companyName,
    error: j.error,
    createdAt: j.createdAt,
    displayName,
  };
}

export function parseUrls(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((u) => u.trim())
    .filter(Boolean)
    .map((u) => {
      if (!/^https?:\/\//i.test(u)) return `https://${u}`;
      return u;
    });
}

export function startResearchJobs(urls: string[]): ResearchJob[] {
  const jobs: ResearchJob[] = [];
  const store = getJobs();

  for (const url of urls) {
    new URL(url); // validate
    const id = randomUUID();
    const job: ResearchJob = {
      id,
      url,
      folderName: "(pending)",
      folderPath: "",
      status: "queued",
      companyName: null,
      error: null,
      createdAt: Date.now(),
      lines: [],
    };
    store.set(id, job);
    persistJobNow(job);
    jobs.push(job);

    // parallel — fire and forget
    void runSearchAgent(id);
  }

  return jobs;
}

export function listJobsForUi(): {
  active: JobUiRow[];
  history: JobUiRow[];
} {
  const store = getJobs();
  return {
    active: listUnfinishedJobs(store).map(toUiRow),
    history: listAllJobs(store).map(toUiRow),
  };
}
