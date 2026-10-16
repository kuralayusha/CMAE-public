import fs from "fs";
import path from "path";
import {
  hasFolderStatusSuffix,
  stripFolderStatusSuffix,
} from "@/lib/research/folder-status";
import { loadJobsFromDisk } from "@/lib/research/persist";
import { getWorkspaceRoot } from "@/lib/research/workspace";
import {
  extractPrimaryEmailFromWorkspace,
  findEmailDraftInFolder,
} from "./parse-mail-md";

export type WorkspaceCandidate = {
  researchJobId: string;
  company: string;
  workspaceFolder: string;
  folderPath: string;
  url: string;
  primaryTo: string | null;
  hasEmailDraft: boolean;
  createdAt: number;
};

function displayCompany(job: {
  companyName: string | null;
  folderName: string;
  url: string;
}): string {
  if (job.companyName?.trim()) return job.companyName.trim();
  const cleaned = stripFolderStatusSuffix(job.folderName)
    .replace(/^\d+\s*-\s*/, "")
    .trim();
  if (cleaned && cleaned !== "(pending)") return cleaned;
  try {
    return new URL(job.url).hostname.replace(/^www\./, "");
  } catch {
    return job.url;
  }
}

function candidateFromJob(job: {
  id: string;
  url: string;
  folderName: string;
  folderPath: string;
  companyName: string | null;
  createdAt: number;
  status: string;
}): WorkspaceCandidate | null {
  if (job.status !== "done") return null;
  const root = getWorkspaceRoot();
  const folderPath =
    job.folderPath && fs.existsSync(job.folderPath)
      ? job.folderPath
      : job.folderName && job.folderName !== "(pending)"
        ? path.join(root, job.folderName)
        : "";
  if (!folderPath || !fs.existsSync(folderPath)) return null;
  if (hasFolderStatusSuffix(path.basename(folderPath))) return null;

  const draft = findEmailDraftInFolder(folderPath);
  return {
    researchJobId: job.id,
    company: displayCompany(job),
    workspaceFolder: path.basename(folderPath),
    folderPath,
    url: job.url,
    primaryTo: extractPrimaryEmailFromWorkspace(folderPath),
    hasEmailDraft: Boolean(draft),
    createdAt: job.createdAt,
  };
}

export function getWorkspaceCandidate(
  researchJobId: string,
): WorkspaceCandidate | null {
  const job = loadJobsFromDisk().find((j) => j.id === researchJobId);
  if (!job) return null;
  return candidateFromJob(job);
}

export function listWorkspaceCandidates(): WorkspaceCandidate[] {
  const out: WorkspaceCandidate[] = [];
  for (const job of loadJobsFromDisk()) {
    const c = candidateFromJob(job);
    if (c) out.push(c);
  }
  return out;
}
