import fs from "fs";
import path from "path";

export type ParsedMailDraft = {
  subject: string;
  body: string;
  fileName: string;
};

/**
 * Parse SUBJECT:/BODY: mail fields.
 * LLMs sometimes wrap labels as **SUBJECT:** / **BODY:** — accept that so
 * email_site_language.md is not skipped in favor of email_tr.md.
 */
export function parseSubjectBody(
  content: string,
): { subject: string; body: string } | null {
  const text = String(content || "").replace(/^\uFEFF/, "");
  const subjectMatch = text.match(/^\*{0,2}SUBJECT:\*{0,2}\s*(.+)$/im);
  const bodyMatch = text.match(/^\*{0,2}BODY:\*{0,2}\s*\r?\n([\s\S]*)$/im);
  if (!subjectMatch || !bodyMatch) return null;
  const subject = subjectMatch[1]!
    .trim()
    .replace(/^\*{1,2}\s*/, "")
    .replace(/\s*\*{1,2}$/, "");
  const body = bodyMatch[1]!.trim();
  if (!subject || !body) return null;
  return { subject, body };
}

/** Re-serialize to canonical SUBJECT:/BODY: (no markdown on labels). */
export function formatSubjectBody(subject: string, body: string): string {
  return `SUBJECT: ${subject.trim()}\nBODY:\n${body.trim()}\n`;
}

export function findEmailDraftInFolder(
  folderPath: string,
  preferredLang?: string,
  opts?: { preferSiteLanguage?: boolean },
): ParsedMailDraft | null {
  if (!folderPath || !fs.existsSync(folderPath)) return null;
  const files = fs.readdirSync(folderPath).filter((f) => /^email_.*\.md$/i.test(f));
  if (!files.length) return null;

  const preferred = preferredLang
    ? files.find((f) => f.toLowerCase() === `email_${preferredLang.toLowerCase()}.md`)
    : null;
  const site = files.find((f) => f.toLowerCase() === "email_site_language.md");
  // ready_to_send → site language first; other callers may prefer user language
  const ordered = (
    opts?.preferSiteLanguage
      ? [site, preferred, ...files]
      : [preferred, site, ...files]
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
  for (const name of ["iletisim.md", "ozet.md"]) {
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
