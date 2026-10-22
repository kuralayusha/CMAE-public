import fs from "fs";
import path from "path";
import { getDb, getSqlite } from "@/lib/db/client";
import { trackerItems } from "@/lib/db/schema";
import { getWorkspaceRoot } from "@/lib/research/workspace";
import { softDeleteItemInTx } from "./item-tx";
import { itemHasAssignedMails } from "./item-mails";

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
 * Soft-delete ready_to_send rows whose workspace folder is gone and that were
 * never linked to mail. Soft-delete (not hard DELETE) so child rows like
 * gmail_drafts do not trip FOREIGN KEY constraint failed.
 */
export function pruneOrphanReadyToSendItems(): number {
  const db = getDb();
  const sqlite = getSqlite();
  const rows = db.select().from(trackerItems).all();
  let removed = 0;
  for (const row of rows) {
    if (row.deletedAt) continue;
    if (row.status !== "ready_to_send") continue;
    if (folderExistsOnDisk(row.workspaceFolder)) continue;
    if (itemHasAssignedMails(row.id)) continue;
    softDeleteItemInTx(sqlite, row.id, "folder_deleted", "sync");
    removed += 1;
  }
  return removed;
}
