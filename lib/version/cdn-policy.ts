import {
  loadBundledPolicy,
  normalizePolicy,
  resolveCdnBase,
  type VersionPolicy,
} from "@/lib/version/policy";

/**
 * Live policy written by CI after each desktop upload.
 * Prefer this over the git-bundled copy so landing links work as soon as
 * Blob upload finishes — no Vercel redeploy required.
 */
export function getCdnPolicyUrl(policy?: VersionPolicy | null): string {
  const cdn = resolveCdnBase(policy || loadBundledPolicy());
  return `${cdn}/releases/policy.json`;
}

export async function fetchCdnPolicy(
  signal?: AbortSignal,
): Promise<VersionPolicy> {
  const bundled = loadBundledPolicy();
  const url = getCdnPolicyUrl(bundled);
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (!res.ok) {
    throw new Error(`CDN policy fetch failed (${res.status}) at ${url}`);
  }
  const data = (await res.json()) as Partial<VersionPolicy>;
  return normalizePolicy({ ...bundled, ...data });
}

/** CDN first, then bundled — never throws. */
export async function loadBestPolicy(
  signal?: AbortSignal,
): Promise<{ policy: VersionPolicy; source: "cdn" | "bundled" }> {
  try {
    const policy = await fetchCdnPolicy(signal);
    return { policy, source: "cdn" };
  } catch {
    return { policy: loadBundledPolicy(), source: "bundled" };
  }
}
