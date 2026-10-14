import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mailFolderCursors } from "@/lib/db/schema";
import type { MailFolder } from "./types";

export type FolderCursor = {
  folder: MailFolder;
  mailboxPath: string;
  uidValidity: string;
  lastUid: number;
};

export function getFolderCursor(folder: MailFolder): FolderCursor | null {
  const db = getDb();
  const row = db
    .select()
    .from(mailFolderCursors)
    .where(eq(mailFolderCursors.folder, folder))
    .get();
  if (!row) return null;
  return {
    folder: row.folder as MailFolder,
    mailboxPath: row.mailboxPath,
    uidValidity: row.uidValidity,
    lastUid: row.lastUid,
  };
}

export function setFolderCursor(cursor: FolderCursor) {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = getFolderCursor(cursor.folder);
  if (existing) {
    db.update(mailFolderCursors)
      .set({
        mailboxPath: cursor.mailboxPath,
        uidValidity: cursor.uidValidity,
        lastUid: cursor.lastUid,
        updatedAt: now,
      })
      .where(eq(mailFolderCursors.folder, cursor.folder))
      .run();
  } else {
    db.insert(mailFolderCursors)
      .values({
        folder: cursor.folder,
        mailboxPath: cursor.mailboxPath,
        uidValidity: cursor.uidValidity,
        lastUid: cursor.lastUid,
        updatedAt: now,
      })
      .run();
  }
}
