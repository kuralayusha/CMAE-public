import fs from "fs";
import path from "path";
import {
  formatSubjectBody,
  parseSubjectBody,
  type SubjectBody,
} from "@/lib/mail/subject-body";
import { WS, WS_LEGACY } from "@/lib/workspace/filenames";

export type ParsedMailDraft = SubjectBody & {
  fileName: string;
};

export {
  formatSubjectBody,
  parseSubjectBody,
  repairShortenedFullName,
} from "@/lib/mail/subject-body";
export type { SubjectBody };

export function findEmailDraftInFolder(
  folderPath: string,
  preferredLang?: string,
  opts?: { preferSiteLanguage?: boolean },
): ParsedMailDraft | null {
  if (!folderPath || !fs.existsSync(folderPath)) return null;
  const files = fs.readdirSync(folderPath).filter((f) => /^email_.*\.md$/i.test(f));
  if (!files.length) return null;

  const original =
    files.find((f) => f.toLowerCase() === WS.emailOriginal) ||
    files.find((f) => f.toLowerCase() === "email_site_language.md");
  const translated = files.find(
    (f) => f.toLowerCase() === WS.emailTranslated,
  );
  const preferred = preferredLang
    ? files.find(
        (f) =>
          f.toLowerCase() === `email_${preferredLang.toLowerCase()}.md`,
      )
    : null;

  // ready_to_send / Gmail → original first; other callers may prefer user language
  const ordered = (
    opts?.preferSiteLanguage
      ? [original, translated, preferred, ...files]
      : [translated, preferred, original, ...files]
  ).filter((f): f is string => Boolean(f));

  const seen = new Set<string>();
  for (const fileName of ordered) {
    if (seen.has(fileName)) continue;
    seen.add(fileName);
    const full = path.join(folderPath, fileName);
    try {
      const content = fs.readFileSync(full, "utf8");
      const parsed = parseSubjectBody(content);
      if (parsed) return { ...parsed, fileName };
    } catch {
      /* skip */
    }
  }
  return null;
}

export function findNamedDraft(
  folderPath: string,
  patterns: RegExp[],
): ParsedMailDraft | null {
  if (!folderPath || !fs.existsSync(folderPath)) return null;
  const files = fs.readdirSync(folderPath);
  for (const re of patterns) {
    const hit = files.find((f) => re.test(f));
    if (!hit) continue;
    try {
      const content = fs.readFileSync(path.join(folderPath, hit), "utf8");
      const parsed = parseSubjectBody(content);
      if (parsed) return { ...parsed, fileName: hit };
    } catch {
      /* skip */
    }
  }
  return null;
}

export function extractPrimaryEmailFromWorkspace(folderPath: string): string | null {
  if (!folderPath || !fs.existsSync(folderPath)) return null;
  const names = [
    WS.contact,
    ...WS_LEGACY.contact,
    WS.summary,
    ...WS_LEGACY.summary,
  ];
  for (const name of names) {
    const full = path.join(/*turbopackIgnore: true*/ folderPath, name);
    if (!fs.existsSync(/*turbopackIgnore: true*/ full)) continue;
    try {
      const text = fs.readFileSync(/*turbopackIgnore: true*/ full, "utf8");
      const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (m) return m[0];
    } catch {
      /* skip */
    }
  }
  return null;
}
