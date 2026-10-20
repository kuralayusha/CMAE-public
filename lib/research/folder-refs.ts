import { eq } from "drizzle-orm";
import path from "path";
import { getDb } from "@/lib/db/client";
import { trackerItemMails, trackerItems } from "@/lib/db/schema";
import { emitTrackerLive } from "@/lib/tracker/live";
import { getJobs } from "./events";
import { loadJobsFromDisk, persistJobNow } from "./persist";
import type { ResearchJob } from "./types";
import { getWorkspaceRoot } from "./workspace";

function itemHasMails(itemId: number): boolean {
  const row = getDb()
    .select({ id: trackerItemMails.id })
    .from(trackerItemMails)
    .where(eq(trackerItemMails.itemId, itemId))
    .get();
  return Boolean(row);
}

/** Keep tracker + search-job refs in sync after a top-level workspace folder rename/delete. */
export function syncTopLevelFolderRefs(
  oldName: string,
  next: { name: string; absolutePath: string } | null,
) {
  if (!oldName || oldName.includes("/")) return;

  let trackerChanged = false;
  try {
    const db = getDb();
    const updatedAt = new Date().toISOString();
    if (next) {
      const result = db
        .update(trackerItems)
        .set({ workspaceFolder: next.name, updatedAt })
        .where(eq(trackerItems.workspaceFolder, oldName))
        .run();
      trackerChanged = (result.changes ?? 0) > 0;
    } else {
      const rows = db
        .select()
        .from(trackerItems)
        .where(eq(trackerItems.workspaceFolder, oldName))
        .all();
      for (const row of rows) {
        const hasMails = itemHasMails(row.id);
        // Research-only row (no outbound yet): remove from tracker entirely.
        if (row.status === "ready_to_send" && !hasMails) {
          db.delete(trackerItemMails)
            .where(eq(trackerItemMails.itemId, row.id))
            .run();
          db.delete(trackerItems).where(eq(trackerItems.id, row.id)).run();
          trackerChanged = true;
          continue;
        }
        // Mail history exists: unlink workspace/drafts, keep the conversation row.
        db.update(trackerItems)
          .set({
            workspaceFolder: null,
            researchJobId: null,
            hasFollowUpDraft: 0,
            hasThanksDraft: 0,
            hasReplyDraft: 0,
            updatedAt,
          })
          .where(eq(trackerItems.id, row.id))
          .run();
        trackerChanged = true;
      }
    }
  } catch (err) {
    console.error("[syncTopLevelFolderRefs] tracker", err);
  }

  if (trackerChanged) {
    emitTrackerLive({ type: "refresh" });
  }

  const root = getWorkspaceRoot();
  const oldAbs = path.join(root, oldName);
  const store = getJobs();
  const seen = new Set<string>();

  const touch = (job: ResearchJob) => {
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
