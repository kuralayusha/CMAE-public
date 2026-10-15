import fs from "fs";
import path from "path";
import { getWorkspaceRoot } from "@/lib/search/workspace";

export const MAX_CV_COUNT = 4;

export type CvEntry = {
  /** Stable id = sanitized file stem */
  id: string;
  fileName: string;
  label: string;
  language: string;
  tags: string[];
  isDefault: boolean;
  /** Parsed plain text for agents */
  text: string;
  updatedAt: string;
};

type CvIndex = {
  version: 1;
  entries: CvEntry[];
};

export type CvPublic = Omit<CvEntry, "text"> & {
  hasText: boolean;
  textPreview: string;
};

export type CvPick = {
  entry: CvEntry;
  absolutePath: string;
  buffer: Buffer;
  attachFileName: string;
};

function cvsDir(): string {
  return path.join(getWorkspaceRoot(), "cvs");
}

function indexPath(): string {
  return path.join(cvsDir(), "index.json");
}

function ensureDir(): void {
  fs.mkdirSync(cvsDir(), { recursive: true });
}

function sanitizeStem(name: string): string {
  const base = path.basename(name, path.extname(name));
  return (
    base
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 80) || `cv_${Date.now()}`
  );
}

function attachNameFromFullName(fullName: string | null | undefined): string {
  const stem = String(fullName || "CV")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 60);
  return `${stem || "CV"}_CV.pdf`;
}

function readIndexRaw(): CvIndex {
  ensureDir();
  const p = indexPath();
  if (!fs.existsSync(p)) return { version: 1, entries: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as CvIndex;
    if (!raw || !Array.isArray(raw.entries)) return { version: 1, entries: [] };
    return { version: 1, entries: raw.entries.filter((e) => e?.fileName) };
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeIndex(index: CvIndex): void {
  ensureDir();
  fs.writeFileSync(indexPath(), `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function toPublic(e: CvEntry): CvPublic {
  return {
    id: e.id,
    fileName: e.fileName,
    label: e.label,
    language: e.language,
    tags: e.tags,
    isDefault: e.isDefault,
    updatedAt: e.updatedAt,
    hasText: Boolean(e.text?.trim()),
    textPreview: (e.text || "").slice(0, 240),
  };
}

/** Scan disk PDFs and merge into index (orphan files get default meta). */
export function syncCvLibrary(): CvEntry[] {
  ensureDir();
  const index = readIndexRaw();
  const byFile = new Map(index.entries.map((e) => [e.fileName.toLowerCase(), e]));
  const files = fs
    .readdirSync(cvsDir())
    .filter((f) => f.toLowerCase().endsWith(".pdf"));

  const next: CvEntry[] = [];

  for (const fileName of files) {
    const existing = byFile.get(fileName.toLowerCase());
    if (existing) {
      next.push({ ...existing, fileName });
      continue;
    }
    // New file dropped into folder — text parsed lazily on pick/upload
    next.push({
      id: sanitizeStem(fileName),
      fileName,
      label: path.basename(fileName, ".pdf"),
      language: "en",
      tags: [],
      isDefault: false,
      text: "",
      updatedAt: new Date().toISOString(),
    });
  }

  // Ensure one default if any exist
  if (next.length && !next.some((e) => e.isDefault)) {
    next[0]!.isDefault = true;
  }

  writeIndex({ version: 1, entries: next });
  return next;
}

async function ensureEntryText(entry: CvEntry): Promise<CvEntry> {
  if (entry.text?.trim()) return entry;
  const abs = path.join(cvsDir(), entry.fileName);
  if (!fs.existsSync(abs)) return entry;
  try {
    const { parseCvPdf } = await import("./parse");
    const { text } = await parseCvPdf(fs.readFileSync(abs));
    const index = readIndexRaw();
    const updated = index.entries.map((e) =>
      e.id === entry.id
        ? { ...e, text, updatedAt: new Date().toISOString() }
        : e,
    );
    writeIndex({ version: 1, entries: updated });
    return updated.find((e) => e.id === entry.id) || { ...entry, text };
  } catch {
    return entry;
  }
}

export function listCvs(): CvPublic[] {
  return syncCvLibrary().map(toPublic);
}

export function getCvEntries(): CvEntry[] {
  return syncCvLibrary();
}

export async function addCvFromBuffer(
  buffer: Buffer,
  originalName: string,
  meta?: {
    label?: string;
    language?: string;
    tags?: string[];
    isDefault?: boolean;
  },
): Promise<CvPublic> {
  ensureDir();
  const entries = syncCvLibrary();
  if (entries.length >= MAX_CV_COUNT) {
    throw new Error(`At most ${MAX_CV_COUNT} CVs can be stored`);
  }

  let stem = sanitizeStem(originalName);
  let fileName = `${stem}.pdf`;
  let n = 2;
  while (fs.existsSync(path.join(cvsDir(), fileName))) {
    fileName = `${stem}_${n}.pdf`;
    n += 1;
  }

  const { parseCvPdf } = await import("./parse");
  const { text } = await parseCvPdf(buffer);
  fs.writeFileSync(path.join(cvsDir(), fileName), buffer);

  const id = sanitizeStem(fileName);
  const makeDefault = Boolean(meta?.isDefault) || entries.length === 0;
  const nextEntries = entries.map((e) =>
    makeDefault ? { ...e, isDefault: false } : e,
  );
  const entry: CvEntry = {
    id,
    fileName,
    label: meta?.label?.trim() || path.basename(originalName, ".pdf"),
    language: (meta?.language || "en").toLowerCase().slice(0, 8),
    tags: normalizeTags(meta?.tags || []),
    isDefault: makeDefault,
    text,
    updatedAt: new Date().toISOString(),
  };
  nextEntries.push(entry);
  writeIndex({ version: 1, entries: nextEntries });
  return toPublic(entry);
}

export function updateCvMeta(
  id: string,
  patch: {
    label?: string;
    language?: string;
    tags?: string[];
    isDefault?: boolean;
  },
): CvPublic {
  const entries = syncCvLibrary();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx < 0) throw new Error("CV not found");

  let next = entries.map((e) => ({ ...e }));
  const cur = next[idx]!;
  if (patch.label !== undefined) cur.label = patch.label.trim() || cur.label;
  if (patch.language !== undefined) {
    cur.language = patch.language.toLowerCase().slice(0, 8) || cur.language;
  }
  if (patch.tags !== undefined) cur.tags = normalizeTags(patch.tags);
  if (patch.isDefault === true) {
    next = next.map((e) => ({ ...e, isDefault: e.id === id }));
  } else if (patch.isDefault === false && cur.isDefault) {
    cur.isDefault = false;
    if (next.length && !next.some((e) => e.isDefault)) {
      const other = next.find((e) => e.id !== id);
      if (other) other.isDefault = true;
    }
  }
  cur.updatedAt = new Date().toISOString();
  writeIndex({ version: 1, entries: next });
  const saved = next.find((e) => e.id === id)!;
  return toPublic(saved);
}

export function deleteCv(id: string): void {
  const entries = syncCvLibrary();
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error("CV not found");
  const abs = path.join(cvsDir(), entry.fileName);
  if (fs.existsSync(abs)) fs.unlinkSync(abs);
  let next = entries.filter((e) => e.id !== id);
  if (next.length && !next.some((e) => e.isDefault)) {
    next = next.map((e, i) => ({ ...e, isDefault: i === 0 }));
  }
  writeIndex({ version: 1, entries: next });
}

/** Wipe entire CV library (PDFs + index). */
export function clearAllCvs(): void {
  ensureDir();
  const dir = cvsDir();
  for (const name of fs.readdirSync(dir)) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* ignore */
    }
  }
  writeIndex({ version: 1, entries: [] });
}

function normalizeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags) {
    const v = String(t || "")
      .trim()
      .toLowerCase()
      .slice(0, 40);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= 12) break;
  }
  return out;
}

function langKey(code: string | null | undefined): string {
  return String(code || "")
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0] || "";
}

/**
 * Pick best CV by language then position/tag overlap.
 */
export async function pickBestCv(opts: {
  language?: string | null;
  preferredLanguage?: string | null;
  position?: string | null;
  fullName?: string | null;
}): Promise<CvPick | null> {
  let entries = syncCvLibrary();
  if (!entries.length) return null;

  // Fill missing text for scoring agents (attachment only needs PDF)
  entries = await Promise.all(entries.map((e) => ensureEntryText(e)));

  const target = langKey(opts.language);
  const preferred = langKey(opts.preferredLanguage);
  const blob = `${opts.position || ""}`.toLowerCase();

  const scored = entries.map((e) => {
    let score = 0;
    const lang = langKey(e.language);
    if (target && lang === target) score += 100;
    else if (preferred && lang === preferred) score += 40;
    if (e.isDefault) score += 10;
    for (const tag of e.tags) {
      if (tag && blob.includes(tag)) score += 20;
    }
    return { e, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.e.isDefault !== b.e.isDefault) return a.e.isDefault ? -1 : 1;
    return a.e.label.localeCompare(b.e.label);
  });

  const best = scored[0]!.e;
  const absolutePath = path.join(cvsDir(), best.fileName);
  if (!fs.existsSync(absolutePath)) return null;
  const buffer = fs.readFileSync(absolutePath);
  return {
    entry: best,
    absolutePath,
    buffer,
    attachFileName: attachNameFromFullName(opts.fullName),
  };
}

/** Best CV text for search agents (language-aware). */
export async function getBestCvText(opts: {
  language?: string | null;
  preferredLanguage?: string | null;
  position?: string | null;
}): Promise<string | null> {
  const pick = await pickBestCv(opts);
  if (pick?.entry.text?.trim()) return pick.entry.text;
  const entries = syncCvLibrary();
  const def = entries.find((e) => e.isDefault) || entries[0];
  if (!def) return null;
  const filled = await ensureEntryText(def);
  return filled.text?.trim() || null;
}

/** Detect site language from company workspace folder notes. */
export function detectSiteLanguageFromFolder(
  folderPath: string | null,
): string | null {
  if (!folderPath || !fs.existsSync(folderPath)) return null;
  const tryFiles = [
    "summary.md",
    "ozet.md",
    "email_original.md",
    "email_site_language.md",
  ];
  for (const name of tryFiles) {
    const full = path.join(/*turbopackIgnore: true*/ folderPath, name);
    if (!fs.existsSync(/*turbopackIgnore: true*/ full)) continue;
    try {
      const text = fs
        .readFileSync(/*turbopackIgnore: true*/ full, "utf8")
        .slice(0, 2000);
      const m =
        text.match(/Site dili:\s*([a-zA-Z]{2,8})/i) ||
        text.match(/site dili\s*\(([^)]+)\)/i) ||
        text.match(/dil[≈~=]\s*([a-zA-Z]{2,8})/i);
      if (m?.[1]) return langKey(m[1]);
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function getCvsDirPath(): string {
  ensureDir();
  return cvsDir();
}
