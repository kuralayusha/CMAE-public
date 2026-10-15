/**
 * Client + server safe helpers for the remote i18n translation host.
 * Default production host: https://cmae.vercel.app
 */

export const DEFAULT_I18N_REMOTE_BASE = "https://cmae.vercel.app";

/** Base URL without trailing slash, or empty to use same-origin. */
export function getI18nRemoteBase(): string {
  const fromPublic = process.env.NEXT_PUBLIC_CMAE_I18N_URL?.trim();
  const fromServer = process.env.CMAE_I18N_URL?.trim();
  const raw = fromPublic || fromServer || DEFAULT_I18N_REMOTE_BASE;
  return raw.replace(/\/$/, "");
}

/** Absolute translate URL on the remote host. */
export function getRemoteTranslateUrl(): string {
  return `${getI18nRemoteBase()}/api/i18n/translate`;
}

export function isVercelRuntime(): boolean {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
}
