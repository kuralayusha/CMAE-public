import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bumpTrackerRevision } from "@/lib/db/revision";
import { trackerItemMails, trackerItems } from "@/lib/db/schema";
import { getWorkspaceRoot } from "@/lib/research/workspace";

function itemHasMails(itemId: number): boolean {
  const row = getDb()
    .select({ id: trackerItemMails.id })
    .from(trackerItemMails)
    .where(eq(trackerItemMails.itemId, itemId))
    .get();
  return Boolean(row);
}

function folderExistsOnDisk(workspaceFolder: string | null): boolean {
  if (!workspaceFolder) return false;
  const full = path.join(getWorkspaceRoot(), workspaceFolder);
  try {
    return fs.existsSync(full) && fs.statSync(full).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Drop ready_to_send rows that no longer have a workspace folder (or whose
 * folder is gone from disk) and have never been linked to mail.
 */
export function pruneOrphanReadyToSendItems(): number {
  const db = getDb();
  const rows = db.select().from(trackerItems).all();
  let removed = 0;
  for (const row of rows) {
    if (row.status !== "ready_to_send") continue;
    if (folderExistsOnDisk(row.workspaceFolder)) continue;
    if (itemHasMails(row.id)) continue;
    db.delete(trackerItemMails).where(eq(trackerItemMails.itemId, row.id)).run();
    db.delete(trackerItems).where(eq(trackerItems.id, row.id)).run();
    removed += 1;
  }
  // When called from sync, runTrackerSync also bumps; an extra rev is harmless.
  if (removed) {
    bumpTrackerRevision("sync", "delete", "all");
  }
  return removed;
}
