/**
 * Fixed email signature from settings — never invented/edited by the LLM.
 * Body is cut after the closing line (Viele Grüße / Best regards / …), then signature appended as-is.
 */

import { formatSubjectBody, parseSubjectBody } from "@/lib/mail/subject-body";

/** Single-line closings (whole line match, optional trailing punctuation). */
const CLOSING_LINE =
  /^(viele\s*gr[uü](?:ß|ss)e?|mit\s+freundlichen\s+gr[uü](?:ß|ss)en|freundliche\s+gr[uü](?:ß|ss)e|best\s+regards|kind\s+regards|warm\s+regards|with\s+kind\s+regards|yours\s+sincerely|sincerely|sayg[ıi]lar[ıi]mla|iyi\s+[çc]al[ıi][şs]malar|kolay\s+gelsin|cordialement|salutations(?:\s+distingu[eé]es)?|met\s+vriendelijke\s+groet(?:en)?|atenamente|un\s+saludo)[,!.…]*$/i;

export const EMAIL_SIGNATURE_PROMPT_RULES = `
SIGNATURE RULES (mandatory):
- End BODY with exactly one short closing line only (e.g. "Viele Grüße", "Best regards", "Saygılarımla"). Nothing after that line.
- Do NOT write any signature block: no name, title, phone, LinkedIn, address, or "sent from".
- Do NOT invent or alter a signature. A fixed signature is appended unchanged by the system after your closing line.
`.trim();

export function normalizeSignatureNewlines(signature: string): string {
  return String(signature || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Keep body through the last closing line; drop anything the model wrote after it. */
export function stripAfterMailClosing(body: string): string {
  const lines = normalizeSignatureNewlines(body).split("\n");
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!t) continue;
    if (CLOSING_LINE.test(t)) cut = i;
  }
  if (cut < 0) return normalizeSignatureNewlines(body).trimEnd();
  return lines.slice(0, cut + 1).join("\n").trimEnd();
}

/** Cut after closing, then append settings signature verbatim (newlines preserved). */
export function appendEmailSignature(
  body: string,
  signature: string | null | undefined,
): string {
  const sig = normalizeSignatureNewlines(signature || "").trimEnd();
  const base = stripAfterMailClosing(body);
  if (!sig.trim()) return base;
  return `${base}\n\n${sig}\n`;
}

/**
 * Rewrite a SUBJECT:/BODY: draft so BODY gets the fixed signature.
 * If parse fails, treats the whole string as body.
 */
export function applySignatureToMailDraft(
  raw: string,
  signature: string | null | undefined,
): string {
  const parsed = parseSubjectBody(raw);
  if (!parsed) {
    return appendEmailSignature(String(raw || "").replace(/^\uFEFF/, ""), signature);
  }
  return formatSubjectBody(
    parsed.subject,
    appendEmailSignature(parsed.body, signature),
  );
}
