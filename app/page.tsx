import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DownloadLanding } from "@/components/DownloadLanding";
import { isVercelRuntime } from "@/lib/i18n/remote";
import { t } from "@/lib/i18n/t";
import { loadBestPolicy } from "@/lib/version/cdn-policy";
import {
  applyCdnDownloads,
  loadBundledPolicy,
  type VersionPolicy,
} from "@/lib/version/policy";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function generateMetadata(): Promise<Metadata> {
  const title = t("meta.title");
  const description = t("meta.homeDescription");
  const ogAlt = t("meta.ogAlt");
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [{ url: "/icons/icon-512.png", width: 512, height: 512, alt: ogAlt }],
    },
  };
}

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

/**
 * Vercel: public download landing.
 * Desktop / local Next: jump into the app (onboarding gate still applies).
 */
export default async function HomePage() {
  if (isVercelRuntime()) {
    return <DownloadLanding initialPolicy={await policyForLanding()} />;
  }
  redirect("/tracker");
}
