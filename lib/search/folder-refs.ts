import { eq } from "drizzle-orm";
import path from "path";
import { getDb } from "@/lib/db/client";
import { trackerItems } from "@/lib/db/schema";
import { getJobs } from "./events";
import { loadJobsFromDisk, persistJobNow } from "./persist";
import type { SearchJob } from "./types";
import { getWorkspaceRoot } from "./workspace";

/** Keep tracker + search-job refs in sync after a top-level workspace folder rename/delete. */
export function syncTopLevelFolderRefs(
  oldName: string,
  next: { name: string; absolutePath: string } | null,
) {
  if (!oldName || oldName.includes("/")) return;

  try {
    const db = getDb();
    const updatedAt = new Date().toISOString();
    if (next) {
      db
        .update(trackerItems)
        .set({ workspaceFolder: next.name, updatedAt })
        .where(eq(trackerItems.workspaceFolder, oldName))
        .run();
    } else {
      db
        .update(trackerItems)
        .set({ workspaceFolder: null, updatedAt })
        .where(eq(trackerItems.workspaceFolder, oldName))
        .run();
    }
  } catch (err) {
    console.error("[syncTopLevelFolderRefs] tracker", err);
  }

  const root = getWorkspaceRoot();
  const oldAbs = path.join(root, oldName);
  const store = getJobs();
  const seen = new Set<string>();

  const touch = (job: SearchJob) => {
    if (seen.has(job.id)) return;
    const matches =
      job.folderName === oldName ||
      job.folderPath === oldAbs ||
      path.basename(job.folderPath || "") === oldName;
    if (!matches) return;
    seen.add(job.id);
    if (next) {
      job.folderName = next.name;
      job.folderPath = next.absolutePath;
    } else {
      job.folderName = `${oldName} (deleted)`;
      job.folderPath = "";
    }
    try {
      persistJobNow(job);
    } catch (err) {
      console.error("[syncTopLevelFolderRefs] persist", err);
    }
  };

  for (const job of store.values()) touch(job);
  for (const job of loadJobsFromDisk()) {
    touch(store.get(job.id) ?? job);
  }
}
