/** Normalize language codes for comparison (en-US → en, Türkçe → tr when possible). */
export function langKey(raw: string | null | undefined): string {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (!s) return "";
  if (s.startsWith("en")) return "en";
  if (s.startsWith("tr") || s.includes("türk") || s.includes("turk")) return "tr";
  if (s.startsWith("de") || s.includes("german") || s.includes("deutsch"))
    return "de";
  if (s.startsWith("fr") || s.includes("french") || s.includes("français"))
    return "fr";
  const m = s.match(/^([a-z]{2})/);
  return m?.[1] || s.slice(0, 8);
}

export function sameLanguage(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ka = langKey(a);
  const kb = langKey(b);
  if (!ka || !kb) return false;
  return ka === kb;
}

/** Pull SEND_LANGUAGE: xx from LLM output (outside SUBJECT/BODY). */
export function extractSendLanguage(raw: string): {
  text: string;
  language: string | null;
} {
  const text = String(raw || "");
  const m = text.match(/^\s*SEND_LANGUAGE:\s*([a-zA-Z-]{2,16})\s*$/im);
  if (!m) return { text, language: null };
  const language = m[1]!.trim();
  const cleaned = text.replace(/\r?\n?\s*SEND_LANGUAGE:\s*[a-zA-Z-]{2,16}\s*/im, "\n").trim();
  return { text: cleaned, language };
}
