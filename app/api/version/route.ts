import { NextResponse } from "next/server";
import { isVercelRuntime } from "@/lib/i18n/remote";
import {
  computeVersionStatus,
  loadBundledPolicy,
  loadLocalAppVersion,
  type VersionStatus,
} from "@/lib/version/policy";
import { fetchRemotePolicy } from "@/lib/version/remote";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function clientHints(req: Request): { platform: string; arch: string } {
  const url = new URL(req.url);
  const platform =
    url.searchParams.get("platform") ||
    req.headers.get("x-cmae-platform") ||
    "";
  const arch =
    url.searchParams.get("arch") || req.headers.get("x-cmae-arch") || "";
  return {
    platform: platform.trim() || "unknown",
    arch: arch.trim() || "unknown",
  };
}

/**
 * GET /api/version
 * - On Vercel: publish the committed version-policy.json (source of truth for desktops).
 * - On desktop/local: fetch remote policy, compare to this build's package.json version.
 */
export async function GET(req: Request) {
  try {
    const { platform, arch } = clientHints(req);

    if (isVercelRuntime()) {
      const policy = loadBundledPolicy();
      return NextResponse.json({
        host: "vercel",
        policy,
        // Convenience fields for simple clients
        latest: policy.latest,
        minSupported: policy.minSupported,
        force: policy.force,
        releaseUrl: policy.releaseUrl,
        downloads: policy.downloads,
        notes: policy.notes,
      });
    }

    const current = loadLocalAppVersion();
    let policy = loadBundledPolicy();
    let host: string = "bundled";
    try {
      policy = await fetchRemotePolicy();
      host = "remote";
    } catch (err) {
      // Offline / first boot: fall back to bundled policy (never brick the app
      // if the network is down — only force-lock when we know policy says so).
      host = `bundled:${err instanceof Error ? err.message : String(err)}`;
    }

    const status: VersionStatus = computeVersionStatus({
      current,
      policy,
      platform,
      arch,
    });

    return NextResponse.json({
      host,
      policy,
      status,
      ...status,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
