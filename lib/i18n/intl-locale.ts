import { APP_LANGUAGE } from "./types";

/**
 * Map CMAE preferredLanguage → BCP-47 tag for Intl date/time formatting.
 * Uses the app language, not the OS/browser locale.
 */
export function intlLocale(code?: string | null): string {
  const raw = (code || APP_LANGUAGE).trim().replace(/_/g, "-");
  if (!raw) return APP_LANGUAGE;
  const parts = raw.split("-").filter(Boolean);
  if (!parts.length) return APP_LANGUAGE;
  const lang = parts[0]!.toLowerCase();
  if (parts.length === 1) return lang;
  return `${lang}-${parts.slice(1).join("-")}`;
}
