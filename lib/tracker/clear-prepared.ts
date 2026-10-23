/**
 * Drop a prepared outgoing mail: Gmail Drafts copy (if any) and the local
 * template files the tracker keeps for that kind.
 */

import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bumpTrackerRevision } from "@/lib/db/revision";
import { trackerItems, workspaceFiles } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { deleteDraftByMessageId } from "@/lib/mail/gmail-imap-source";
import { getWorkspaceRoot } from "@/lib/research/workspace";
import { getGmailCredentials } from "@/lib/settings/service";
import {
  getLiveDraftForItem,
  markDraftDeletedByUser,
} from "./gmail-drafts-store";
import {
  parsePendingGmailDraft,
  withoutPendingGmailDraft,
} from "./pending-draft";
import type { DraftKind } from "./types";
import { rescanWorkspaceFolder } from "./workspace-index";

const KINDS: DraftKind[] = ["application", "follow_up", "thanks", "reply"];

export function isPreparedMailFile(name: string, kind: DraftKind): boolean {
  const n = name.toLowerCase();
  if (kind === "application") return /^email_.*\.md$/.test(n);
  if (kind === "follow_up") return /^follow_up_\d+(_translated)?\.md$/.test(n);
  if (kind === "thanks") {
    return (
      n === "thanks.md" ||
      n === "thanks_translated.md" ||
      /^tesekkur.*\.md$/.test(n)
    );
  }
  return (
    n === "reply.md" ||
    n === "reply_translated.md" ||
    /^yanit.*\.md$/.test(n)
  );
}

/**
 * The sent Gmail draft and the local template are the same text. Drop the
 * template so the row no longer looks like a mail is still waiting to send.
 * A newer template (different hash) is left in place.
 * Application emails stay; they are the research record, not a one-shot reply.
 */
export function dropPreparedFilesForSentDraft(opts: {
  workspaceFolder: string | null;
  kind: DraftKind;
  contentHash: string | null;
}): boolean {
  if (opts.kind === "application") return false;
  const folderName = opts.workspaceFolder;
  const hash = opts.contentHash;
  if (!folderName || !hash) return false;
  if (folderName.includes("/") || folderName.startsWith(".")) return false;
  const rows = getDb()
    .select()
    .from(workspaceFiles)
    .where(eq(workspaceFiles.folder, folderName))
    .all();
  const kindRows = rows.filter((row) => isPreparedMailFile(row.name, opts.kind));
  if (!kindRows.some((row) => row.contentHash === hash)) return false;
  const folder = path.join(getWorkspaceRoot(), folderName);
  let removed = false;
  for (const row of kindRows) {
    const full = path.join(folder, row.name);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        fs.unlinkSync(full);
        removed = true;
      }
    } catch (err) {
      console.error("[clear-prepared] unlink failed", full, err);
    }
  }
  if (!removed) return false;
  try {
    rescanWorkspaceFolder(folderName);
  } catch (err) {
    console.error("[clear-prepared] workspace rescan failed", err);
  }
  return true;
}

export async function clearPreparedMailForItem(
  itemId: number,
  kind: DraftKind,
): Promise<{ removedFiles: string[]; gmailRemoved: boolean }> {
  if (!KINDS.includes(kind)) {
    throw new Error(t("tracker.error.invalidKind"));
  }
  const db = getDb();
  const item = db
    .select()
    .from(trackerItems)
    .where(eq(trackerItems.id, itemId))
    .get();
  if (!item || item.deletedAt) {
    throw new Error(t("tracker.error.notFound"));
  }

  const live = getLiveDraftForItem(itemId, kind);
  if (live?.state === "creating") {
    throw new Error(t("tracker.error.gmailDraftStillCreating"));
  }

  let gmailRemoved = false;
  if (live) {
    if (live.messageIdHdr && !live.messageIdHdr.startsWith("legacy:")) {
      const creds = getGmailCredentials();
      if (!creds) {
        throw new Error(t("tracker.error.gmailCredentialsMissing"));
      }
      gmailRemoved = await deleteDraftByMessageId(
        creds.address,
        creds.appPassword,
        live.messageIdHdr,
      );
    }
    markDraftDeletedByUser(live.id);
  }

  const removedFiles: string[] = [];
  const folderName = item.workspaceFolder;
  if (folderName && !folderName.includes("/") && !folderName.startsWith(".")) {
    const folder = path.join(getWorkspaceRoot(), folderName);
    if (fs.existsSync(folder)) {
      for (const name of fs.readdirSync(folder)) {
        if (!isPreparedMailFile(name, kind)) continue;
        const full = path.join(folder, name);
        if (!fs.statSync(full).isFile()) continue;
        fs.unlinkSync(full);
        removedFiles.push(name);
      }
    }
    try {
      rescanWorkspaceFolder(folderName);
    } catch (err) {
      console.error("[clear-prepared] workspace rescan failed", err);
    }
  }

  const pending = parsePendingGmailDraft(item.notesJson);
  if (pending?.kind === kind) {
    db.update(trackerItems)
      .set({ notesJson: withoutPendingGmailDraft(item.notesJson) })
      .where(eq(trackerItems.id, itemId))
      .run();
  }

  bumpTrackerRevision("mutation", "upsert", [itemId]);
  return { removedFiles, gmailRemoved };
}
