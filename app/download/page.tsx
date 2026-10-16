import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DownloadLanding } from "@/components/DownloadLanding";
import { isVercelRuntime } from "@/lib/i18n/remote";
import { loadBestPolicy } from "@/lib/version/cdn-policy";
import {
  applyCdnDownloads,
  loadBundledPolicy,
  type VersionPolicy,
} from "@/lib/version/policy";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Download CMAE",
  description: "Download the CMAE desktop app for macOS and Windows",
  robots: { index: false, follow: false },
};

async function policyForLanding(): Promise<VersionPolicy> {
  try {
    const { policy } = await loadBestPolicy();
    return policy;
  } catch {
    try {
      return applyCdnDownloads(loadBundledPolicy());
    } catch {
      return applyCdnDownloads({
        latest: "0.1.0",
        minSupported: "0.1.0",
        force: false,
        releaseUrl: "",
        downloads: {},
        notes: "",
      });
    }
  }
}

/** Alias: on Vercel, `/` is the landing — keep `/download` working too. */
export default async function DownloadPage() {
  if (isVercelRuntime()) {
    redirect("/");
  }
  return <DownloadLanding initialPolicy={await policyForLanding()} />;
}
