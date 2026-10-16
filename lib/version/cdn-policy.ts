import {
  loadBundledPolicy,
  normalizePolicy,
  resolveReleasesRepo,
  type VersionPolicy,
} from "@/lib/version/policy";

/**
 * Live policy attached to each GitHub Release on the public releases repo.
 * Prefer this over the git-bundled copy so landing links update as soon as
 * assets are uploaded — no Vercel redeploy required.
 */
export function getCdnPolicyUrl(policy?: VersionPolicy | null): string {
  const bundled = policy || loadBundledPolicy();
  const repo = resolveReleasesRepo(bundled);
  const version = bundled.latest.replace(/^v/i, "");
  return `https://github.com/${repo}/releases/download/v${version}/policy.json`;
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
    redirect: "follow",
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
