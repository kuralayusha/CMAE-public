import { getConfiguredI18nRemoteBase } from "@/lib/i18n/remote";
import {
  loadBundledPolicy,
  normalizePolicy,
  type VersionPolicy,
} from "@/lib/version/policy";

/**
 * Same host pattern as i18n: default https://cmae.vercel.app
 * Override with CMAE_VERSION_URL (absolute policy URL) or CMAE_I18N_URL base.
 */
export function getRemoteVersionPolicyUrl(): string | null {
  const exact = (
    process.env.CMAE_VERSION_URL ||
    process.env.NEXT_PUBLIC_CMAE_VERSION_URL ||
    ""
  ).trim();
  if (exact === "local" || exact === "0" || exact === "false") return null;
  if (exact) return exact.replace(/\/$/, "");

  const base = getConfiguredI18nRemoteBase();
  if (!base) return null;
  return `${base}/api/version`;
}

export async function fetchRemotePolicy(
  signal?: AbortSignal,
): Promise<VersionPolicy> {
  const url = getRemoteVersionPolicyUrl();
  if (!url) return loadBundledPolicy();

  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    throw new Error(`Version policy fetch failed (${res.status}) at ${url}`);
  }
  const data = (await res.json()) as Partial<VersionPolicy> & {
    policy?: Partial<VersionPolicy>;
  };
  // Accept either bare policy or { policy: {...} }
  return normalizePolicy(data.policy || data);
}
