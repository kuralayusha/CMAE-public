import { createRequire } from "module";
import { isBelow } from "@/lib/version/semver";

export type VersionDownloads = {
  "darwin-arm64"?: string;
  "darwin-x64"?: string;
  "win32-x64"?: string;
  "win32-ia32"?: string;
};

export type VersionPolicy = {
  latest: string;
  minSupported: string;
  /** When true, lock even if current meets minSupported but is behind latest. */
  force: boolean;
  /** Public Vercel Blob origin (no trailing slash). */
  cdnBase?: string;
  releaseUrl: string;
  /** electron-updater generic feed directory (latest-mac.yml / latest.yml). */
  updateFeedUrl?: string;
  downloads: VersionDownloads;
  notes?: string;
};

const DEFAULT_CDN_BASE =
  "https://j99zof4rag1z9ajs.public.blob.vercel-storage.com";

export function resolveCdnBase(policy?: Partial<VersionPolicy> | null): string {
  const fromEnv = (process.env.CMAE_CDN_BASE || "").trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  const fromPolicy = String(policy?.cdnBase || "")
    .trim()
    .replace(/\/$/, "");
  return fromPolicy || DEFAULT_CDN_BASE;
}

/** Fill download / release URLs from cdnBase + latest when missing. */
export function applyCdnDownloads(policy: VersionPolicy): VersionPolicy {
  const cdn = resolveCdnBase(policy);
  const version = policy.latest.replace(/^v/i, "");
  const downloads: VersionDownloads = { ...policy.downloads };
  if (!downloads["darwin-arm64"]) {
    downloads["darwin-arm64"] =
      `${cdn}/releases/CMAE-${version}-arm64-mac.zip`;
  }
  if (!downloads["win32-x64"]) {
    downloads["win32-x64"] = `${cdn}/releases/CMAE-${version}-win-x64.exe`;
  }
  return {
    ...policy,
    cdnBase: cdn,
    releaseUrl: policy.releaseUrl || `${cdn}/releases`,
    updateFeedUrl: policy.updateFeedUrl || `${cdn}/releases`,
    downloads,
  };
}

export type VersionPlatformKey = keyof VersionDownloads;

export type VersionStatus = {
  current: string;
  latest: string;
  minSupported: string;
  force: boolean;
  updateAvailable: boolean;
  /** Soft: newer version exists but app may keep running. */
  softUpdate: boolean;
  /** Hard: UI must lock until user updates. */
  forceLock: boolean;
  releaseUrl: string;
  downloadUrl: string | null;
  notes: string;
  checkedAt: string;
};

const require = createRequire(import.meta.url);

export function loadLocalAppVersion(): string {
  try {
    const pkg = require("../../package.json") as { version?: string };
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

export function loadBundledPolicy(): VersionPolicy {
  const raw = require("../../version-policy.json") as VersionPolicy;
  return normalizePolicy(raw);
}

export function normalizePolicy(raw: Partial<VersionPolicy> | null | undefined): VersionPolicy {
  const downloads = (raw?.downloads && typeof raw.downloads === "object"
    ? raw.downloads
    : {}) as VersionDownloads;
  const cdn = resolveCdnBase(raw);
  const latest = String(raw?.latest || "0.0.0").replace(/^v/i, "");
  return applyCdnDownloads({
    latest,
    minSupported: String(raw?.minSupported || "0.0.0").replace(/^v/i, ""),
    force: Boolean(raw?.force),
    cdnBase: cdn,
    releaseUrl: String(raw?.releaseUrl || `${cdn}/releases`),
    updateFeedUrl: String(raw?.updateFeedUrl || `${cdn}/releases`),
    downloads,
    notes: String(raw?.notes || ""),
  });
}

export function platformDownloadKey(
  platform: string,
  arch: string,
): VersionPlatformKey | null {
  if (platform === "darwin") {
    return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (platform === "win32") {
    return arch === "ia32" ? "win32-ia32" : "win32-x64";
  }
  return null;
}

export function resolveDownloadUrl(
  policy: VersionPolicy,
  platform: string,
  arch: string,
): string | null {
  const key = platformDownloadKey(platform, arch);
  if (key && policy.downloads[key]) return policy.downloads[key]!;
  return policy.releaseUrl || null;
}

export function computeVersionStatus(opts: {
  current: string;
  policy: VersionPolicy;
  platform?: string;
  arch?: string;
}): VersionStatus {
  const current = String(opts.current || "0.0.0").replace(/^v/i, "");
  const policy = opts.policy;
  const updateAvailable = isBelow(current, policy.latest);
  const belowMin = isBelow(current, policy.minSupported);
  const forceLock = belowMin || (policy.force && updateAvailable);
  const softUpdate = updateAvailable && !forceLock;
  const downloadUrl =
    opts.platform && opts.arch
      ? resolveDownloadUrl(policy, opts.platform, opts.arch)
      : policy.releaseUrl || null;

  return {
    current,
    latest: policy.latest,
    minSupported: policy.minSupported,
    force: policy.force,
    updateAvailable,
    softUpdate,
    forceLock,
    releaseUrl: policy.releaseUrl,
    downloadUrl,
    notes: policy.notes || "",
    checkedAt: new Date().toISOString(),
  };
}
