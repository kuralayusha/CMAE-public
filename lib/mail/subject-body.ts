/**
 * Canonical SUBJECT:/BODY: mail draft fields.
 * Shared by server writers and client preview (no Node fs).
 */

export type SubjectBody = { subject: string; body: string };

function cleanLabelNoise(s: string): string {
  return s
    .trim()
    .replace(/^\*{1,2}\s*/, "")
    .replace(/\s*\*{1,2}$/, "")
    .trim();
}

/**
 * Parse SUBJECT:/BODY: mail fields.
 * Tolerates common LLM mess:
 * - **SUBJECT:** / **BODY:** markdown wrapping
 * - SUBJECT and BODY on the same line
 * - BODY: with body text starting on the same line
 * - Leading markdown titles before SUBJECT
 */
export function parseSubjectBody(content: string): SubjectBody | null {
  const text = String(content || "").replace(/^\uFEFF/, "");
  if (!text.trim()) return null;

  const subjectLabel = /(?:^|\n)\s*\*{0,2}SUBJECT:\*{0,2}\s*/i;
  const sm = subjectLabel.exec(text);
  if (!sm) return null;

  const afterSubject = text.slice(sm.index + sm[0].length);
  const bodyLabel = /\*{0,2}BODY:\*{0,2}\s*/i;
  const bm = bodyLabel.exec(afterSubject);
  if (!bm) return null;

  const subject = cleanLabelNoise(
    afterSubject.slice(0, bm.index).replace(/\r?\n/g, " "),
  );
  const body = afterSubject
    .slice(bm.index + bm[0].length)
    .replace(/^\r?\n/, "")
    .trim();

  if (!subject || !body) return null;
  return { subject, body };
}

/** Re-serialize to canonical SUBJECT:/BODY: (no markdown on labels). */
export function formatSubjectBody(subject: string, body: string): string {
  return `SUBJECT: ${subject.trim()}\nBODY:\n${body.trim()}\n`;
}

/** Drop leading ATX H1 lines (system already prepends the file title). */
export function stripLeadingMarkdownH1(md: string): string {
  let s = String(md || "")
    .replace(/^\uFEFF/, "")
    .replace(/^\s+/, "");
  // Exactly one # (not ##) at line start
  while (/^#\s+[^\n]+/.test(s) && !/^##/.test(s)) {
    s = s.replace(/^#\s+[^\n]+\r?\n*/, "").replace(/^\s+/, "");
  }
  return s;
}
