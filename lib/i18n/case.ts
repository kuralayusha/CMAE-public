/**
 * Locale-aware uppercase (Turkish: i→İ, ı→I).
 * Prefer this over CSS `text-transform: uppercase`, which often ignores language.
 */
export function localeUpper(
  text: string,
  localeCode: string | null | undefined,
): string {
  const raw = String(text ?? "");
  if (!raw) return raw;
  const loc = String(localeCode || "en")
    .trim()
    .replace(/_/g, "-")
    .slice(0, 16) || "en";
  try {
    return raw.toLocaleUpperCase(loc);
  } catch {
    try {
      return raw.toLocaleUpperCase(loc.slice(0, 2));
    } catch {
      return raw.toUpperCase();
    }
  }
}
