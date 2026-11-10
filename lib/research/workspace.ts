import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { t } from "@/lib/i18n/t";
import { getWorkspaceRootPath } from "@/lib/paths";
import { isTranslatedMailFile } from "@/lib/workspace/filenames";
import {
  folderStatusSuffix,
  hasFolderStatusSuffix,
  type FolderStatusKind,
} from "./folder-status";

function workspaceRoot() {
  return getWorkspaceRootPath();
}

/** Serializes create / renumber so concurrent runs never share the same index. */
let folderIndexLock: Promise<void> = Promise.resolve();

function withFolderIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = folderIndexLock.then(fn, fn);
  folderIndexLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function safeName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Company";
}

function parseNumberedFolder(
  name: string,
): { index: number; rest: string } | null {
  const m = name.match(/^(\d+)\s*-\s*(.*)$/);
  if (!m) return null;
  return { index: Number(m[1]), rest: m[2] ?? "" };
}

async function listNumberedTopLevel(): Promise<
  { index: number; name: string; rest: string }[]
> {
  await fs.mkdir(workspaceRoot(), { recursive: true });
  const entries = await fs.readdir(workspaceRoot());
  const out: { index: number; name: string; rest: string }[] = [];
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    const parsed = parseNumberedFolder(e);
    if (!parsed) continue;
    try {
      const st = await fs.stat(path.join(workspaceRoot(), e));
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    out.push({ index: parsed.index, name: e, rest: parsed.rest });
  }
  out.sort((a, b) => a.index - b.index || a.name.localeCompare(b.name));
  return out;
}

async function nextIndexUnlocked(): Promise<number> {
  const numbered = await listNumberedTopLevel();
  let max = 0;
  for (const e of numbered) max = Math.max(max, e.index);
  return max + 1;
}

/**
 * After a gap (deleted top-level folder), renumber so indices are 1..N contiguous.
 * Higher numbers shift down; tracker + search job refs stay in sync via callback.
 */
export async function compactTopLevelFolderIndices(
  onRenamed?: (oldName: string, next: { name: string; absolutePath: string }) => void,
): Promise<{ from: string; to: string }[]> {
  return withFolderIndexLock(async () => {
    const numbered = await listNumberedTopLevel();
    const changes: { from: string; to: string }[] = [];
    const pending: { oldName: string; tempPath: string; finalName: string }[] =
      [];

    for (let i = 0; i < numbered.length; i++) {
      const item = numbered[i]!;
      const targetIndex = i + 1;
      const finalName = `${targetIndex}- ${item.rest}`;
      if (item.name === finalName) continue;
      const tempPath = path.join(
        workspaceRoot(),
        `.__renum_${targetIndex}_${Date.now()}_${i}`,
      );
      await fs.rename(path.join(workspaceRoot(), item.name), tempPath);
      pending.push({ oldName: item.name, tempPath, finalName });
    }

    for (const p of pending) {
      const dest = path.join(workspaceRoot(), p.finalName);
      if (!dest.startsWith(workspaceRoot() + path.sep)) {
        throw new Error(t("folders.error.invalidPath"));
      }
      await fs.rename(p.tempPath, dest);
      changes.push({ from: p.oldName, to: p.finalName });
      onRenamed?.(p.oldName, { name: p.finalName, absolutePath: dest });
    }

    return changes;
  });
}

export async function createCompanyFolder(companyName: string): Promise<{
  index: number;
  folderName: string;
  folderPath: string;
}> {
  return withFolderIndexLock(async () => {
    await fs.mkdir(workspaceRoot(), { recursive: true });
    let index = await nextIndexUnlocked();
    const base = safeName(companyName);

    // Retry on rare name clash (e.g. leftover folder)
    for (let attempt = 0; attempt < 50; attempt++) {
      const folderName = `${index}- ${base}`;
      const folderPath = path.join(workspaceRoot(), folderName);
      if (!folderPath.startsWith(workspaceRoot() + path.sep) && folderPath !== workspaceRoot()) {
        throw new Error(t("folders.error.invalidPath"));
      }
      try {
        await fs.mkdir(folderPath);
        try {
          const { noteWorkspaceFolderCreated } = await import(
            "@/lib/tracker/workspace-index"
          );
          noteWorkspaceFolderCreated(folderName);
        } catch (err) {
          console.error("[workspace] index folder create failed", err);
        }
        return { index, folderName, folderPath };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EEXIST") {
          index += 1;
          continue;
        }
        throw err;
      }
    }
    throw new Error(t("folders.error.assignIndexFailed"));
  });
}

export async function renameCompanyFolder(
  currentPath: string,
  companyName: string,
): Promise<{ folderName: string; folderPath: string }> {
  return withFolderIndexLock(async () => {
    const base = path.basename(currentPath);
    const parsed = parseNumberedFolder(base);
    const index = parsed ? String(parsed.index) : String(await nextIndexUnlocked());
    const folderName = `${index}- ${safeName(companyName)}`;
    const folderPath = path.join(workspaceRoot(), folderName);
    if (!folderPath.startsWith(workspaceRoot() + path.sep)) {
      throw new Error(t("folders.error.invalidPath"));
    }
    if (folderPath !== currentPath) {
      await renameWorkspaceDirOrReuse(currentPath, folderPath);
    }
    return { folderName, folderPath };
  });
}

/**
 * Rename in place. Never mkdir a twin on failure — that orphaned empty
 * `N- host` folders beside the real company folder during cancel/compact races.
 */
async function renameWorkspaceDirOrReuse(
  currentPath: string,
  folderPath: string,
): Promise<void> {
  const sourceExists = await fs
    .stat(currentPath)
    .then((s) => s.isDirectory())
    .catch(() => false);
  const targetExists = await fs
    .stat(folderPath)
    .then((s) => s.isDirectory())
    .catch(() => false);

  if (!sourceExists) {
    // Cancel/compact already moved or deleted the source — keep target if present.
    if (targetExists) return;
    throw new Error(t("folders.error.pathNotFound"));
  }
  if (currentPath === folderPath) return;
  if (targetExists) {
    // Same index, different name already taken — do not create a third folder.
    throw new Error(t("folders.error.nameExists"));
  }
  await fs.rename(currentPath, folderPath);
}

export async function writeFile(
  folderPath: string,
  fileName: string,
  content: string,
): Promise<string> {
  if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
    throw new Error(t("folders.error.invalidName"));
  }
  if (!folderPath.startsWith(workspaceRoot() + path.sep)) {
    throw new Error(t("folders.error.invalidFolder"));
  }
  await fs.mkdir(folderPath, { recursive: true });
  const full = path.join(folderPath, fileName);
  await fs.writeFile(full, content, "utf8");
  try {
    const { noteWorkspaceFileWrite } = await import(
      "@/lib/tracker/workspace-index"
    );
    noteWorkspaceFileWrite(folderPath, fileName, content);
  } catch (err) {
    console.error("[workspace] index write failed", err);
  }
  return full;
}

export function getWorkspaceRoot() {
  return workspaceRoot();
}

/** Open path in OS file manager (Finder / Explorer / xdg-open). */
export async function revealInFileManager(relativePath = ""): Promise<{
  path: string;
  absolutePath: string;
}> {
  const full = resolveWorkspacePath(relativePath);
  let st;
  try {
    st = await fs.stat(full);
  } catch {
    throw new Error(t("folders.error.pathNotFound"));
  }

  const platform = process.platform;
  await new Promise<void>((resolve, reject) => {
    let child;
    if (platform === "darwin") {
      // Reveal file in Finder; for dirs just open the folder
      child = st.isDirectory()
        ? spawn("open", [full], { stdio: "ignore", detached: true })
        : spawn("open", ["-R", full], { stdio: "ignore", detached: true });
    } else if (platform === "win32") {
      child = st.isDirectory()
        ? spawn("explorer", [full], { stdio: "ignore", detached: true })
        : spawn("explorer", ["/select,", full], {
            stdio: "ignore",
            detached: true,
          });
    } else {
      const target = st.isDirectory() ? full : path.dirname(full);
      child = spawn("xdg-open", [target], { stdio: "ignore", detached: true });
    }
    child.on("error", reject);
    child.unref();
    // Don't wait for the GUI process to exit
    resolve();
  });

  return {
    path: toRelative(full),
    absolutePath: full,
  };
}

export type WorkspaceEntryBadge = {
  /** Shown next to filename, e.g. "(empty)", "(2)", "(for AI)" */
  text: string;
  /** muted = faded empty; ok = has links / for user; ai = internal agent notes */
  tone: "muted" | "ok" | "ai";
};

/**
 * Agent scratch files — not primary user deliverables. Turkish names (ozet,
 * rotalar, iletisim, ...) are legacy file names kept for older folders.
 */
const FOR_AI_FILES = new Set([
  "summary.md",
  "ozet.md",
  "review.md",
  "routes.md",
  "rotalar.md",
  "contact.md",
  "iletisim.md",
]);

// "sirket_bilgileri" is the legacy Turkish file name still present in older folders.
function isCompanyInfoFile(name: string): boolean {
  return /^(company_info|sirket_bilgileri)(_translated)?\.md$/i.test(name);
}

/** Site-language mail draft — used by both user and AI. */
function isEmailOriginalFile(name: string): boolean {
  return (
    /^email_original\.md$/i.test(name) ||
    /^email_site_language\.md$/i.test(name)
  );
}

/** Other user-facing mail drafts (translated copies handled separately). */
function isUserFacingMailDraft(name: string): boolean {
  if (isEmailOriginalFile(name)) return false;
  return (
    /^email_/i.test(name) ||
    /^follow_up_/i.test(name) ||
    /^followup/i.test(name) ||
    /^thanks/i.test(name) ||
    /^tesekkur/i.test(name) || // legacy Turkish file name (thanks)
    /^reply/i.test(name) ||
    /^yanit/i.test(name) // legacy Turkish file name (reply)
  );
}

export type WorkspaceEntry = {
  name: string;
  relativePath: string;
  kind: "dir" | "file";
  size: number;
  mtime: number;
  /** @deprecated prefer `badges` — kept as first badge for older clients */
  badge?: WorkspaceEntryBadge | null;
  badges?: WorkspaceEntryBadge[];
};

function isHttpishUrl(u: string): boolean {
  return /https?:\/\//i.test(u) || /^www\./i.test(u);
}

/** Count job URLs in job_links.md / legacy basvuru_linkleri.md (jobfit output). */
export function analyzeJobLinks(content: string): {
  count: number;
  empty: boolean;
} {
  const text = String(content || "");
  // Explicit empty templates (EN + legacy Turkish output; the Turkish regexes
  // are intentional, they must match old files) — only when no URLs present
  const looksEmptyTemplate =
    /uygun\s+a[cç][ıi]k\s+ilan\s+yok/i.test(text) ||
    /no\s+matching\s+(open\s+)?(job|role)/i.test(text) ||
    /a[cç][ıi]k\s+pozisyon\s+bulunamad[ıi]/i.test(text) ||
    /cold\s*\/\s*speculative\s+application/i.test(text) ||
    /spek[üu]latif\s+ba[sş]vuru/i.test(text);

  // "- Link: url" / "- Bağlantı: url" (Turkish label, intentionally matched) / any "- Label: http…" (locale-agnostic)
  const fromLinkLines = [...text.matchAll(/^\s*-\s*[^:\n]{1,80}:\s*(\S+)/gim)]
    .map((m) => (m[1] || "").replace(/[),.;]+$/, ""))
    .filter(isHttpishUrl);

  const fromMd = [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/gi)].map((m) =>
    m[1]!.replace(/[),.;]+$/, ""),
  );

  // Prefer per-role link lines (same URL on two jobs → count 2); else unique md links
  const count =
    fromLinkLines.length > 0
      ? fromLinkLines.length
      : new Set(fromMd).size;

  if (count === 0 && looksEmptyTemplate) {
    return { count: 0, empty: true };
  }
  return { count, empty: count === 0 };
}

async function hasTranslatedCompanyInfo(dir: string): Promise<boolean> {
  // sirket_bilgileri_translated.md = legacy Turkish file name kept for older folders
  for (const file of ["company_info_translated.md", "sirket_bilgileri_translated.md"]) {
    try {
      await fs.access(path.join(/*turbopackIgnore: true*/ dir, file));
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

async function badgesForEntry(
  name: string,
  kind: "dir" | "file",
  fullPath: string,
): Promise<WorkspaceEntryBadge[]> {
  if (kind !== "file") return [];

  const forUser = (): WorkspaceEntryBadge => ({
    text: t("folders.forUser"),
    tone: "ok",
  });
  const forAi = (): WorkspaceEntryBadge => ({
    text: t("folders.forAi"),
    tone: "ai",
  });

  if (isCompanyInfoFile(name)) {
    if (/_translated\.md$/i.test(name)) return [forUser()];
    // Original-language note. With a translated copy the user reads that one
    // and the original is CMAE's input. Without one (site language = user's
    // language, so no translation is made) this single file serves both.
    return (await hasTranslatedCompanyInfo(path.dirname(fullPath)))
      ? [forAi()]
      : [forUser(), forAi()];
  }

  if (isTranslatedMailFile(name)) {
    return [forUser()];
  }

  if (isEmailOriginalFile(name)) {
    return [forUser(), forAi()];
  }

  if (/^(job_links|basvuru_linkleri)\.md$/i.test(name)) {
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      const { count, empty } = analyzeJobLinks(raw);
      if (empty || count === 0) {
        return [{ text: t("folders.empty"), tone: "muted" }];
      }
      return [{ text: String(count), tone: "ok" }];
    } catch {
      return [];
    }
  }

  if (isUserFacingMailDraft(name)) {
    return [forUser()];
  }

  if (FOR_AI_FILES.has(name.toLowerCase())) {
    return [forAi()];
  }

  return [];
}

/** Resolve a relative path inside workspace; throws on traversal. */
export function resolveWorkspacePath(relativePath = ""): string {
  const cleaned = String(relativePath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (cleaned.includes("\0") || cleaned.split("/").some((p) => p === "..")) {
    throw new Error(t("folders.error.invalidPath"));
  }
  const full = path.resolve(workspaceRoot(), cleaned);
  if (full !== workspaceRoot() && !full.startsWith(workspaceRoot() + path.sep)) {
    throw new Error(t("folders.error.invalidPath"));
  }
  return full;
}

function toRelative(full: string): string {
  if (full === workspaceRoot()) return "";
  return path.relative(workspaceRoot(), full).split(path.sep).join("/");
}

export async function listWorkspace(relativePath = ""): Promise<{
  path: string;
  breadcrumbs: { name: string; path: string }[];
  entries: WorkspaceEntry[];
}> {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const top = normalized.split("/")[0]?.toLowerCase() || "";
  if (top === "cvs") {
    throw new Error(t("folders.error.notVisible"));
  }

  const dir = resolveWorkspacePath(relativePath);
  await fs.mkdir(workspaceRoot(), { recursive: true });

  let st;
  try {
    st = await fs.stat(dir);
  } catch {
    throw new Error(t("folders.error.folderNotFound"));
  }
  if (!st.isDirectory()) {
    throw new Error(t("folders.error.notAFolder"));
  }

  const rel = toRelative(dir);
  const parts = rel ? rel.split("/") : [];
  const breadcrumbs: { name: string; path: string }[] = [
    { name: "workspace", path: "" },
  ];
  for (let i = 0; i < parts.length; i++) {
    breadcrumbs.push({
      name: parts[i],
      path: parts.slice(0, i + 1).join("/"),
    });
  }

  // System / private dirs — not shown in Folders UI
  const HIDDEN_TOP_LEVEL = new Set(["cvs"]);

  const names = await fs.readdir(dir);
  const entries: WorkspaceEntry[] = [];
  for (const name of names) {
    if (name === ".gitkeep" || name.startsWith(".")) continue;
    // Hide CV library at workspace root
    if (!rel && HIDDEN_TOP_LEVEL.has(name.toLowerCase())) continue;
    const full = path.join(dir, name);
    try {
      const s = await fs.stat(full);
      const kind = s.isDirectory() ? "dir" : "file";
      // Workspace root: only numbered company folders (`1- Acme`), never loose
      // agent temp files (e.g. mail-tr-temp.json) or other junk.
      if (!rel) {
        if (kind !== "dir" || !parseNumberedFolder(name)) continue;
      }
      const badges = await badgesForEntry(name, kind, full);
      entries.push({
        name,
        relativePath: toRelative(full),
        kind,
        size: s.size,
        mtime: s.mtimeMs,
        badges,
        badge: badges[0] ?? null,
      });
    } catch {
      /* skip unreadable */
    }
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, "tr", { numeric: true, sensitivity: "base" });
  });

  return { path: rel, breadcrumbs, entries };
}

const TEXT_EXT = new Set([
  ".md",
  ".txt",
  ".json",
  ".csv",
  ".html",
  ".htm",
  ".xml",
  ".yml",
  ".yaml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".css",
  ".svg",
  ".log",
  ".env",
  ".gitignore",
]);

export async function readWorkspaceFile(relativePath: string): Promise<{
  path: string;
  name: string;
  content: string;
  size: number;
  mtime: number;
  binary: boolean;
}> {
  const full = resolveWorkspacePath(relativePath);
  if (full === workspaceRoot()) throw new Error(t("folders.error.filePathRequired"));

  let st;
  try {
    st = await fs.stat(full);
  } catch {
    throw new Error(t("folders.error.fileNotFound"));
  }
  if (!st.isFile()) throw new Error(t("folders.error.notAFile"));
  if (st.size > 2_000_000) throw new Error(t("folders.error.fileTooLarge", { max: "2 MB" }));

  const name = path.basename(full);
  const ext = path.extname(name).toLowerCase();
  const looksText = !ext || TEXT_EXT.has(ext);

  if (!looksText) {
    return {
      path: toRelative(full),
      name,
      content: "",
      size: st.size,
      mtime: st.mtimeMs,
      binary: true,
    };
  }

  const buf = await fs.readFile(full);
  // Heuristic: too many null bytes → binary
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  let nulls = 0;
  for (const b of sample) if (b === 0) nulls++;
  if (nulls > 0) {
    return {
      path: toRelative(full),
      name,
      content: "",
      size: st.size,
      mtime: st.mtimeMs,
      binary: true,
    };
  }

  return {
    path: toRelative(full),
    name,
    content: buf.toString("utf8"),
    size: st.size,
    mtime: st.mtimeMs,
    binary: false,
  };
}

function safeEntryName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error(t("folders.error.invalidName"));
  }
  return cleaned;
}

/** Rename a file or folder inside workspace (real FS rename). */
export async function renameWorkspaceEntry(
  relativePath: string,
  newName: string,
): Promise<{ path: string; name: string; kind: "dir" | "file" }> {
  const full = resolveWorkspacePath(relativePath);
  if (full === workspaceRoot()) throw new Error(t("folders.error.rootRename"));

  let st;
  try {
    st = await fs.stat(full);
  } catch {
    throw new Error(t("folders.error.pathNotFound"));
  }

  const nextName = safeEntryName(newName);
  const parent = path.dirname(full);
  const target = path.join(parent, nextName);
  if (target !== workspaceRoot() && !target.startsWith(workspaceRoot() + path.sep)) {
    throw new Error(t("folders.error.invalidPath"));
  }
  if (target === full) {
    return {
      path: toRelative(full),
      name: path.basename(full),
      kind: st.isDirectory() ? "dir" : "file",
    };
  }

  const targetExists = await fs.stat(target).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return false;
      throw err;
    },
  );
  if (targetExists) throw new Error(t("folders.error.nameExists"));

  await fs.rename(full, target);
  return {
    path: toRelative(target),
    name: nextName,
    kind: st.isDirectory() ? "dir" : "file",
  };
}

/** Delete a file or folder inside workspace (recursive for dirs). */
export async function deleteWorkspaceEntry(
  relativePath: string,
): Promise<{ path: string }> {
  const full = resolveWorkspacePath(relativePath);
  if (full === workspaceRoot()) throw new Error(t("folders.error.rootDelete"));

  try {
    await fs.stat(full);
  } catch {
    throw new Error(t("folders.error.pathNotFound"));
  }

  await fs.rm(full, { recursive: true, force: false });
  return { path: toRelative(full) };
}

/** Append localized status suffix to folder name, keep numeric prefix. */
export async function markFolderStatus(
  currentPath: string,
  kind: FolderStatusKind,
): Promise<{
  folderName: string;
  folderPath: string;
}> {
  if (!currentPath.startsWith(workspaceRoot() + path.sep)) {
    throw new Error(t("folders.error.invalidFolder"));
  }
  const base = path.basename(currentPath);
  if (hasFolderStatusSuffix(base)) {
    return { folderName: base, folderPath: currentPath };
  }
  const suffix = folderStatusSuffix(kind);
  const folderName = suffix ? `${base} ${suffix}` : base;
  const folderPath = path.join(workspaceRoot(), folderName);
  if (!folderPath.startsWith(workspaceRoot() + path.sep)) {
    throw new Error(t("folders.error.invalidFolder"));
  }
  await renameWorkspaceDirOrReuse(currentPath, folderPath);
  return { folderName, folderPath };
}

export async function markFolderCanceled(currentPath: string) {
  return markFolderStatus(currentPath, "canceled");
}

export async function markFolderError(currentPath: string) {
  return markFolderStatus(currentPath, "error");
}
