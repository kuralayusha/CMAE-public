/**
 * Remote i18n translation host.
 *
 * Desktop/local apps proxy language-pack translation here so OPENROUTER_API_KEY
 * lives only on the server — not inside the shipped desktop app.
 */

export const DEFAULT_I18N_REMOTE_BASE = "https://cmae.vercel.app";

/**
 * Remote base URL (no trailing slash).
 * - Unset → default host (https://cmae.vercel.app)
 * - "local" / "0" / "false" → translate on this machine instead
 */
export function getConfiguredI18nRemoteBase(): string | null {
  const raw = (
    process.env.CMAE_I18N_URL ||
    process.env.NEXT_PUBLIC_CMAE_I18N_URL ||
    ""
  ).trim();
  if (raw === "local" || raw === "0" || raw === "false") return null;
  if (!raw) return DEFAULT_I18N_REMOTE_BASE;
  return raw.replace(/\/$/, "");
}

/** Absolute translate URL, or null when local-only mode is forced. */
export function getRemoteTranslateUrl(): string | null {
  const base = getConfiguredI18nRemoteBase();
  if (!base) return null;
  return `${base}/api/i18n/translate`;
}

export function isVercelRuntime(): boolean {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
}
