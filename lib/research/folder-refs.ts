import { eq } from "drizzle-orm";
import path from "path";
import { getDb, getSqlite } from "@/lib/db/client";
import { bumpRevision } from "@/lib/db/revision";
import { trackerItems } from "@/lib/db/schema";
import { emitTrackerLive } from "@/lib/tracker/live";
import { softDeleteItemInTx } from "@/lib/tracker/item-tx";
import { itemHasAssignedMails } from "@/lib/tracker/item-mails";
import { getJobs } from "./events";
import { loadJobsFromDisk, persistJobNow } from "./persist";
import type { ResearchJob } from "./types";
import { getWorkspaceRoot } from "./workspace";

/** Keep tracker + search-job refs in sync after a top-level workspace folder rename/delete. */
export function syncTopLevelFolderRefs(
  oldName: string,
  next: { name: string; absolutePath: string } | null,
) {
  if (!oldName || oldName.includes("/")) return;

  let trackerChanged = false;
  try {
    const sqlite = getSqlite();
    const run = sqlite.transaction(() => {
      const db = getDb();
      const updatedAt = new Date().toISOString();
      if (next) {
        const result = db
          .update(trackerItems)
          .set({ workspaceFolder: next.name, updatedAt })
          .where(eq(trackerItems.workspaceFolder, oldName))
          .run();
        trackerChanged = (result.changes ?? 0) > 0;
        if (trackerChanged) {
          bumpRevision(sqlite, "fs", "global", "all");
        }
        return;
      }

      const rows = db
        .select()
        .from(trackerItems)
        .where(eq(trackerItems.workspaceFolder, oldName))
        .all()
        .filter((r) => !r.deletedAt);

      let anySoftDelete = false;
      const unlinked: number[] = [];

      for (const row of rows) {
        const hasMails = itemHasAssignedMails(row.id);
        // Research-only row (no outbound yet): soft-delete.
        if (row.status === "ready_to_send" && !hasMails) {
          softDeleteItemInTx(sqlite, row.id, "folder_deleted", "fs");
          anySoftDelete = true;
          trackerChanged = true;
          continue;
        }
        // Mail history: keep workspaceFolder name so UI can show
        // "Research folder not found" via workspace_folders.present=0.
        db.update(trackerItems)
          .set({
            researchJobId: null,
            updatedAt,
          })
          .where(eq(trackerItems.id, row.id))
          .run();
        unlinked.push(row.id);
        trackerChanged = true;
      }

      if (unlinked.length && !anySoftDelete) {
        bumpRevision(sqlite, "fs", "upsert", unlinked);
      } else if (unlinked.length && anySoftDelete) {
        bumpRevision(sqlite, "fs", "upsert", unlinked);
      }
    });
    run.immediate();
  } catch (err) {
    console.error("[syncTopLevelFolderRefs] tracker", err);
  }

  // Keep workspace index in sync (tracker soft-delete already done above).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const idx = require("@/lib/tracker/workspace-index") as typeof import("@/lib/tracker/workspace-index");
    if (next) {
      idx.renameWorkspaceIndexFolder(oldName, next.name);
    } else {
      idx.markWorkspaceFolderAbsent(oldName);
    }
  } catch (err) {
    console.error("[syncTopLevelFolderRefs] workspace index", err);
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
