/**
 * Faz 7: workspace_files / workspace_folders index.
 * Write-path updates + fs.watch + periodic full scan.
 * GET/list reads recipients and draft flags from here — no fs.
 */

import fs from "fs";
import path from "path";
import { and, eq } from "drizzle-orm";
import { getDb, getSqlite } from "@/lib/db/client";
import { bumpRevision } from "@/lib/db/revision";
import {
  trackerItems,
  workspaceFiles,
  workspaceFolders,
} from "@/lib/db/schema";
import { getWorkspaceRoot } from "@/lib/research/workspace";
import { softDeleteItemInTx } from "@/lib/tracker/item-tx";
import { itemHasAssignedMails } from "@/lib/tracker/item-mails";
import { emitTrackerLive } from "@/lib/tracker/live";
import { WS, WS_LEGACY } from "@/lib/workspace/filenames";
import { contentHashForDraft } from "./gmail-drafts-store";
import { parseSubjectBody } from "./parse-mail-md";
import { parseContactRecipientsFromText } from "./recipients";
import type { DraftKind } from "./types";

export type WorkspaceFileKind =
  | "email"
  | "follow_up_n"
  | "thanks"
  | "reply"
  | "contact"
  | "summary"
  | "other";

export type DraftFlagsFromIndex = {
  hasApplicationDraft: boolean;
  hasFollowUpDraft: boolean;
  hasThanksDraft: boolean;
  hasReplyDraft: boolean;
};

type FileRow = {
  folder: string;
  name: string;
  kind: string | null;
  mtimeMs: number | null;
  size: number | null;
  subject: string | null;
  contentHash: string | null;
  metaJson: string | null;
};

const WATCH_DEBOUNCE_MS = 500;
const APP_WRITE_SUPPRESS_MS = 1_500;

declare global {
  // eslint-disable-next-line no-var
  var __cmaeWorkspaceWatcher: {
    started: boolean;
    watcher: fs.FSWatcher | null;
    debounce: ReturnType<typeof setTimeout> | null;
    pendingFolders: Set<string>;
    fullRescan: boolean;
    suppressUntil: Map<string, number>;
  } | undefined;
}

function watcherState() {
  if (!globalThis.__cmaeWorkspaceWatcher) {
    globalThis.__cmaeWorkspaceWatcher = {
      started: false,
      watcher: null,
      debounce: null,
      pendingFolders: new Set(),
      fullRescan: false,
      suppressUntil: new Map(),
    };
  }
  return globalThis.__cmaeWorkspaceWatcher;
}

function suppressAppWrite(folder: string) {
  const s = watcherState();
  s.suppressUntil.set(folder, Date.now() + APP_WRITE_SUPPRESS_MS);
}

function isSuppressed(folder: string): boolean {
  const until = watcherState().suppressUntil.get(folder);
  if (!until) return false;
  if (Date.now() > until) {
    watcherState().suppressUntil.delete(folder);
    return false;
  }
  return true;
}

export function classifyWorkspaceFileKind(name: string): WorkspaceFileKind {
  const n = name.toLowerCase();
  if (
    n === WS.contact.toLowerCase() ||
    WS_LEGACY.contact.some((x) => x.toLowerCase() === n)
  ) {
    return "contact";
  }
  if (
    n === WS.summary.toLowerCase() ||
    WS_LEGACY.summary.some((x) => x.toLowerCase() === n)
  ) {
    return "summary";
  }
  if (/^email_.*\.md$/i.test(name) || /^email\.md$/i.test(name)) {
    return "email";
  }
  if (/^follow_up_\d+(_translated)?\.md$/i.test(name)) {
    return "follow_up_n";
  }
  if (
    /^thanks(_translated)?\.md$/i.test(name) ||
    /^tesekkur.*\.md$/i.test(name)
  ) {
    return "thanks";
  }
  if (
    /^reply(_translated)?\.md$/i.test(name) ||
    /^yanit.*\.md$/i.test(name)
  ) {
    return "reply";
  }
  return "other";
}

function topLevelFolderFromAbs(absPath: string): string | null {
  const root = getWorkspaceRoot();
  const full = path.resolve(absPath);
  if (full === root) return null;
  if (!full.startsWith(root + path.sep)) return null;
  const rel = path.relative(root, full).split(path.sep).filter(Boolean);
  return rel[0] || null;
}

function folderNameFromAbsDir(folderPath: string): string | null {
  const root = getWorkspaceRoot();
  const full = path.resolve(folderPath);
  if (full === root) return null;
  if (!full.startsWith(root + path.sep)) return null;
  const rel = path.relative(root, full);
  if (!rel || rel.includes("..") || rel.includes(path.sep)) {
    // Only top-level company folders are indexed as folders.
    const top = rel.split(path.sep)[0];
    return top || null;
  }
  return rel;
}

function itemToForFolder(folder: string): string {
  const item = getSqlite()
    .prepare(
      `SELECT id, primary_to AS primaryTo, selected_recipient AS selectedRecipient
       FROM tracker_items
       WHERE workspace_folder = ? AND deleted_at IS NULL
       LIMIT 1`,
    )
    .get(folder) as
    | {
        id: number;
        primaryTo: string | null;
        selectedRecipient: string | null;
      }
    | undefined;
  if (!item) return "";
  // Prefer live Gmail draft To so index hash matches gmail_drafts.content_hash.
  try {
    const live = getSqlite()
      .prepare(
        `SELECT to_addr AS toAddr FROM gmail_drafts
         WHERE item_id = ? AND state IN ('creating','present','unknown')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(item.id) as { toAddr: string } | undefined;
    if (live?.toAddr?.trim()) return live.toAddr.trim();
  } catch {
    /* gmail_drafts may be absent mid-migration */
  }
  return (item.selectedRecipient || item.primaryTo || "").trim();
}

function buildIndexedFields(
  folder: string,
  name: string,
  content: string,
  st: { mtimeMs: number; size: number },
): Omit<FileRow, "folder" | "name"> {
  const kind = classifyWorkspaceFileKind(name);
  let subject: string | null = null;
  let contentHash: string | null = null;
  let metaJson: string | null = null;

  if (
    kind === "email" ||
    kind === "follow_up_n" ||
    kind === "thanks" ||
    kind === "reply"
  ) {
    // Skip translated user copies for hash / subject (send drafts are originals).
    if (!/translated/i.test(name) && !/^email_translated\.md$/i.test(name)) {
      const parsed = parseSubjectBody(content);
      if (parsed) {
        subject = parsed.subject;
        const to = itemToForFolder(folder);
        contentHash = contentHashForDraft({
          subject: parsed.subject,
          to,
          body: parsed.body,
        });
      }
    }
  } else if (kind === "contact") {
    const recipients = parseContactRecipientsFromText(content);
    metaJson = JSON.stringify(recipients);
  }

  return {
    kind,
    mtimeMs: st.mtimeMs,
    size: st.size,
    subject,
    contentHash,
    metaJson,
  };
}

function upsertFileRow(row: FileRow): void {
  getSqlite()
    .prepare(
      `INSERT INTO workspace_files (
         folder, name, kind, mtime_ms, size, subject, content_hash, meta_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(folder, name) DO UPDATE SET
         kind = excluded.kind,
         mtime_ms = excluded.mtime_ms,
         size = excluded.size,
         subject = excluded.subject,
         content_hash = excluded.content_hash,
         meta_json = excluded.meta_json`,
    )
    .run(
      row.folder,
      row.name,
      row.kind,
      row.mtimeMs,
      row.size,
      row.subject,
      row.contentHash,
      row.metaJson,
    );
}

function deleteFileRow(folder: string, name: string): void {
  getSqlite()
    .prepare(`DELETE FROM workspace_files WHERE folder = ? AND name = ?`)
    .run(folder, name);
}

function setFolderPresent(folder: string, present: boolean, scannedAt: string) {
  getSqlite()
    .prepare(
      `INSERT INTO workspace_folders (folder, present, scanned_at)
       VALUES (?, ?, ?)
       ON CONFLICT(folder) DO UPDATE SET
         present = excluded.present,
         scanned_at = excluded.scanned_at`,
    )
    .run(folder, present ? 1 : 0, scannedAt);
}

function listIndexedNames(folder: string): Set<string> {
  const rows = getSqlite()
    .prepare(`SELECT name FROM workspace_files WHERE folder = ?`)
    .all(folder) as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function itemHasMails(itemId: number): boolean {
  return itemHasAssignedMails(itemId);
}

/** Index-only: folder absent, clear file rows, bump revision. */
export function markWorkspaceFolderAbsent(folder: string): void {
  if (!folder || folder.includes("/")) return;
  suppressAppWrite(folder);
  const sqlite = getSqlite();
  const run = sqlite.transaction(() => {
    setFolderPresent(folder, false, new Date().toISOString());
    sqlite.prepare(`DELETE FROM workspace_files WHERE folder = ?`).run(folder);
    const itemIds = sqlite
      .prepare(
        `SELECT id FROM tracker_items
         WHERE workspace_folder = ? AND deleted_at IS NULL`,
      )
      .all(folder) as { id: number }[];
    bumpRevision(
      sqlite,
      "fs",
      "upsert",
      itemIds.length ? itemIds.map((r) => r.id) : "all",
    );
  });
  run.immediate();
}

/**
 * Folder gone from disk (Finder delete / external). Soft-delete research-only
 * ready_to_send; keep mail-history rows with workspaceFolder for warning UX.
 */
export function applyMissingFolderSemantics(folder: string): boolean {
  if (!folder || folder.includes("/")) return false;
  let changed = false;
  const sqlite = getSqlite();
  const run = sqlite.transaction(() => {
    const rows = getDb()
      .select()
      .from(trackerItems)
      .where(eq(trackerItems.workspaceFolder, folder))
      .all()
      .filter((r) => !r.deletedAt);

    const updatedAt = new Date().toISOString();
    const unlinked: number[] = [];
    let anySoftDelete = false;

    for (const row of rows) {
      const hasMails = itemHasMails(row.id);
      if (row.status === "ready_to_send" && !hasMails) {
        softDeleteItemInTx(sqlite, row.id, "folder_deleted", "fs");
        anySoftDelete = true;
        changed = true;
        continue;
      }
      getDb()
        .update(trackerItems)
        .set({
          researchJobId: null,
          updatedAt,
        })
        .where(eq(trackerItems.id, row.id))
        .run();
      unlinked.push(row.id);
      changed = true;
    }

    setFolderPresent(folder, false, updatedAt);
    sqlite.prepare(`DELETE FROM workspace_files WHERE folder = ?`).run(folder);

    if (unlinked.length) {
      bumpRevision(sqlite, "fs", "upsert", unlinked);
    } else if (!anySoftDelete) {
      bumpRevision(sqlite, "fs", "global", "all");
      changed = true;
    }
    // softDeleteItemInTx already bumps when anySoftDelete && !unlinked
  });
  run.immediate();
  return changed;
}

/** After app rename: move index rows folder key. */
export function renameWorkspaceIndexFolder(
  oldName: string,
  newName: string,
): void {
  if (!oldName || !newName || oldName === newName) return;
  suppressAppWrite(oldName);
  suppressAppWrite(newName);
  const sqlite = getSqlite();
  const run = sqlite.transaction(() => {
    sqlite
      .prepare(`UPDATE workspace_files SET folder = ? WHERE folder = ?`)
      .run(newName, oldName);
    sqlite.prepare(`DELETE FROM workspace_folders WHERE folder = ?`).run(oldName);
    setFolderPresent(newName, true, new Date().toISOString());
  });
  run.immediate();
}

/**
 * Call after every app file write (same logical path as disk write).
 * Updates index + revision inside a transaction.
 */
export function noteWorkspaceFileWrite(
  folderPath: string,
  fileName: string,
  content: string,
): void {
  const folder = folderNameFromAbsDir(folderPath);
  if (!folder || folder.includes(path.sep)) return;
  if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
    return;
  }

  suppressAppWrite(folder);
  const full = path.join(folderPath, fileName);
  let mtimeMs = Date.now();
  let size = Buffer.byteLength(content, "utf8");
  try {
    const st = fs.statSync(full);
    mtimeMs = Math.round(st.mtimeMs);
    size = st.size;
  } catch {
    /* use content length */
  }

  const fields = buildIndexedFields(folder, fileName, content, {
    mtimeMs,
    size,
  });
  const sqlite = getSqlite();
  const run = sqlite.transaction(() => {
    upsertFileRow({ folder, name: fileName, ...fields });
    setFolderPresent(folder, true, new Date().toISOString());
    const itemIds = sqlite
      .prepare(
        `SELECT id FROM tracker_items
         WHERE workspace_folder = ? AND deleted_at IS NULL`,
      )
      .all(folder) as { id: number }[];
    bumpRevision(
      sqlite,
      "fs",
      "upsert",
      itemIds.length ? itemIds.map((r) => r.id) : "all",
    );
  });
  run.immediate();
  emitTrackerLive({ type: "refresh" });
}

/** Mark folder present after mkdir (createCompanyFolder). */
export function noteWorkspaceFolderCreated(folderName: string): void {
  if (!folderName || folderName.includes("/")) return;
  suppressAppWrite(folderName);
  const sqlite = getSqlite();
  const run = sqlite.transaction(() => {
    setFolderPresent(folderName, true, new Date().toISOString());
    bumpRevision(sqlite, "fs", "global", "all");
  });
  run.immediate();
}

export function draftFlagsFromIndex(
  workspaceFolder: string | null,
  followUpCount: number,
): DraftFlagsFromIndex {
  if (!workspaceFolder) {
    return {
      hasApplicationDraft: false,
      hasFollowUpDraft: false,
      hasThanksDraft: false,
      hasReplyDraft: false,
    };
  }
  const present = getDb()
    .select()
    .from(workspaceFolders)
    .where(eq(workspaceFolders.folder, workspaceFolder))
    .get();
  if (present && !present.present) {
    return {
      hasApplicationDraft: false,
      hasFollowUpDraft: false,
      hasThanksDraft: false,
      hasReplyDraft: false,
    };
  }

  const rows = getDb()
    .select()
    .from(workspaceFiles)
    .where(eq(workspaceFiles.folder, workspaceFolder))
    .all();
  const names = rows.map((r) => r.name);
  const n = Math.max(1, (followUpCount || 0) + 1);
  const hasApplicationDraft = names.some(
    (f) =>
      /^email_original\.md$/i.test(f) ||
      /^email_site_language\.md$/i.test(f) ||
      (/^email_.*\.md$/i.test(f) && !/translated/i.test(f)),
  );
  const hasFollowUpDraft = names.some(
    (f) =>
      new RegExp(`^follow_up_${n}\\.md$`, "i").test(f) ||
      /^follow_up_\d+\.md$/i.test(f),
  );
  const hasThanksDraft = names.some(
    (f) => /^thanks\.md$/i.test(f) || /^tesekkur.*\.md$/i.test(f),
  );
  const hasReplyDraft = names.some(
    (f) => /^reply\.md$/i.test(f) || /^yanit.*\.md$/i.test(f),
  );
  return {
    hasApplicationDraft,
    hasFollowUpDraft,
    hasThanksDraft,
    hasReplyDraft,
  };
}

export { loadRecipientsFromIndex } from "./recipients-from-index";

export function isWorkspaceFolderPresent(
  workspaceFolder: string | null,
): boolean | null {
  if (!workspaceFolder) return null;
  const row = getDb()
    .select()
    .from(workspaceFolders)
    .where(eq(workspaceFolders.folder, workspaceFolder))
    .get();
  if (!row) return null; // unknown — not scanned yet
  return Boolean(row.present);
}

/** Indexed content_hash for the draft file matching kind (if any). */
export function indexedDraftContentHash(
  workspaceFolder: string | null,
  kind: DraftKind,
  followUpCount: number,
): string | null {
  if (!workspaceFolder) return null;
  const rows = getDb()
    .select()
    .from(workspaceFiles)
    .where(eq(workspaceFiles.folder, workspaceFolder))
    .all();
  if (!rows.length) return null;

  let match: (typeof rows)[0] | undefined;
  if (kind === "application") {
    match =
      rows.find((r) => r.name.toLowerCase() === WS.emailOriginal) ||
      rows.find((r) => r.name.toLowerCase() === "email_site_language.md") ||
      rows.find((r) => r.kind === "email" && r.contentHash);
  } else if (kind === "follow_up") {
    const n = Math.max(1, (followUpCount || 0) + 1);
    match =
      rows.find((r) => new RegExp(`^follow_up_${n}\\.md$`, "i").test(r.name)) ||
      rows.find((r) => /^follow_up_\d+\.md$/i.test(r.name) && r.contentHash);
  } else if (kind === "thanks") {
    match =
      rows.find((r) => /^thanks\.md$/i.test(r.name)) ||
      rows.find((r) => /^tesekkur.*\.md$/i.test(r.name));
  } else if (kind === "reply") {
    match =
      rows.find((r) => /^reply\.md$/i.test(r.name)) ||
      rows.find((r) => /^yanit.*\.md$/i.test(r.name));
  }
  return match?.contentHash || null;
}

/**
 * Rescan one top-level folder; apply missing-folder semantics if gone.
 * Returns whether tracker revision was bumped / tracker changed.
 */
export function rescanWorkspaceFolder(folderName: string): {
  changed: boolean;
  missing: boolean;
} {
  if (!folderName || folderName.includes("/") || folderName.startsWith(".")) {
    return { changed: false, missing: false };
  }
  if (isSuppressed(folderName)) {
    return { changed: false, missing: false };
  }

  const root = getWorkspaceRoot();
  const abs = path.join(root, folderName);
  let isDir = false;
  try {
    isDir = fs.statSync(abs).isDirectory();
  } catch {
    isDir = false;
  }

  if (!isDir) {
    const prev = getDb()
      .select()
      .from(workspaceFolders)
      .where(eq(workspaceFolders.folder, folderName))
      .get();
    // Also apply if tracker still points here even without prior index row.
    const linked = getSqlite()
      .prepare(
        `SELECT 1 AS ok FROM tracker_items
         WHERE workspace_folder = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(folderName) as { ok: number } | undefined;
    if ((prev && prev.present) || linked) {
      const changed = applyMissingFolderSemantics(folderName);
      if (changed) emitTrackerLive({ type: "refresh" });
      return { changed, missing: true };
    }
    if (prev && !prev.present) {
      return { changed: false, missing: true };
    }
    return { changed: false, missing: true };
  }

  const scannedAt = new Date().toISOString();
  const entries = fs.readdirSync(abs);
  const seen = new Set<string>();
  let diff = false;
  const sqlite = getSqlite();

  const run = sqlite.transaction(() => {
    const before = listIndexedNames(folderName);
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const full = path.join(abs, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (!name.toLowerCase().endsWith(".md")) continue;
      seen.add(name);
      let content = "";
      try {
        content = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const fields = buildIndexedFields(folderName, name, content, {
        mtimeMs: Math.round(st.mtimeMs),
        size: st.size,
      });
      const prev = getDb()
        .select()
        .from(workspaceFiles)
        .where(
          and(
            eq(workspaceFiles.folder, folderName),
            eq(workspaceFiles.name, name),
          ),
        )
        .get();
      if (
        !prev ||
        prev.mtimeMs !== fields.mtimeMs ||
        prev.size !== fields.size ||
        prev.contentHash !== fields.contentHash ||
        prev.metaJson !== fields.metaJson ||
        prev.subject !== fields.subject ||
        prev.kind !== fields.kind
      ) {
        upsertFileRow({ folder: folderName, name, ...fields });
        diff = true;
      }
    }
    for (const old of before) {
      if (!seen.has(old)) {
        deleteFileRow(folderName, old);
        diff = true;
      }
    }
    const folderRow = getDb()
      .select()
      .from(workspaceFolders)
      .where(eq(workspaceFolders.folder, folderName))
      .get();
    if (!folderRow || !folderRow.present) {
      diff = true;
    }
    setFolderPresent(folderName, true, scannedAt);
    if (diff) {
      const itemIds = sqlite
        .prepare(
          `SELECT id FROM tracker_items
           WHERE workspace_folder = ? AND deleted_at IS NULL`,
        )
        .all(folderName) as { id: number }[];
      bumpRevision(
        sqlite,
        "fs",
        "upsert",
        itemIds.length ? itemIds.map((r) => r.id) : "all",
      );
    }
  });
  run.immediate();

  if (diff) emitTrackerLive({ type: "refresh" });
  return { changed: diff, missing: false };
}

/** Full workspace scan — startup + workspace_scan job. */
export function fullWorkspaceScan(): {
  folders: number;
  changed: boolean;
  missing: number;
} {
  const root = getWorkspaceRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    /* ignore */
  }

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    entries = [];
  }

  const onDisk = new Set<string>();
  let changed = false;
  let missing = 0;

  for (const e of entries) {
    if (e.startsWith(".")) continue;
    const abs = path.join(root, e);
    try {
      if (!fs.statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    onDisk.add(e);
    const r = rescanWorkspaceFolder(e);
    if (r.changed) changed = true;
    if (r.missing) missing += 1;
  }

  // Indexed folders no longer on disk
  const indexed = getDb().select().from(workspaceFolders).all();
  for (const row of indexed) {
    if (onDisk.has(row.folder)) continue;
    if (!row.present && !getSqlite()
      .prepare(
        `SELECT 1 AS ok FROM tracker_items
         WHERE workspace_folder = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(row.folder)) {
      continue;
    }
    const r = applyMissingFolderSemantics(row.folder);
    if (r) {
      changed = true;
      missing += 1;
      emitTrackerLive({ type: "refresh" });
    }
  }

  // Tracker folders never indexed
  const trackerFolders = getSqlite()
    .prepare(
      `SELECT DISTINCT workspace_folder AS folder FROM tracker_items
       WHERE workspace_folder IS NOT NULL AND deleted_at IS NULL`,
    )
    .all() as { folder: string }[];
  for (const { folder } of trackerFolders) {
    if (!folder || onDisk.has(folder)) continue;
    const r = applyMissingFolderSemantics(folder);
    if (r) {
      changed = true;
      missing += 1;
      emitTrackerLive({ type: "refresh" });
    }
  }

  return { folders: onDisk.size, changed, missing };
}

function flushWatchDebounce() {
  const s = watcherState();
  s.debounce = null;
  const full = s.fullRescan;
  const folders = [...s.pendingFolders];
  s.pendingFolders.clear();
  s.fullRescan = false;

  try {
    if (full) {
      fullWorkspaceScan();
      return;
    }
    for (const f of folders) {
      rescanWorkspaceFolder(f);
    }
  } catch (err) {
    console.error("[workspace-index] watch rescan failed", err);
  }
}

function scheduleWatchRescan(folder: string | null) {
  const s = watcherState();
  if (folder) s.pendingFolders.add(folder);
  else s.fullRescan = true;
  if (s.debounce) clearTimeout(s.debounce);
  s.debounce = setTimeout(flushWatchDebounce, WATCH_DEBOUNCE_MS);
  if (typeof s.debounce === "object" && s.debounce && "unref" in s.debounce) {
    s.debounce.unref();
  }
}

/** Start recursive fs.watch on workspace root (HMR-safe). */
export function startWorkspaceWatcher(): void {
  const s = watcherState();
  if (s.started) return;
  s.started = true;

  const root = getWorkspaceRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    /* ignore */
  }

  try {
    const watcher = fs.watch(
      root,
      { recursive: true },
      (_event, filename) => {
        if (!filename) {
          scheduleWatchRescan(null);
          return;
        }
        const asStr = filename.toString();
        const top = asStr.split(path.sep).filter(Boolean)[0];
        if (!top || top.startsWith(".")) return;
        if (isSuppressed(top)) return;
        scheduleWatchRescan(top);
      },
    );
    s.watcher = watcher;
    watcher.on("error", (err) => {
      console.error("[workspace-index] fs.watch error", err);
    });
  } catch (err) {
    console.error("[workspace-index] fs.watch unavailable", err);
  }
}

export function stopWorkspaceWatcher(): void {
  const s = watcherState();
  if (s.debounce) clearTimeout(s.debounce);
  s.debounce = null;
  try {
    s.watcher?.close();
  } catch {
    /* ignore */
  }
  s.watcher = null;
  s.started = false;
}
