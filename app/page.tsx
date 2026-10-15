import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DownloadLanding } from "@/components/DownloadLanding";
import { isVercelRuntime } from "@/lib/i18n/remote";
import {
  loadBundledPolicy,
  type VersionPolicy,
} from "@/lib/version/policy";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "CMAE",
  description: "Cold Mail AI Engine — download the desktop app",
};

function policyOrFallback(): VersionPolicy {
  try {
    return loadBundledPolicy();
  } catch {
    return {
      latest: "0.1.0",
      minSupported: "0.1.0",
      force: false,
      releaseUrl: "https://github.com/kuralayusha/CMAE/releases/latest",
      downloads: {},
      notes: "",
    };
  }
}

/**
 * Vercel: public download landing.
 * Desktop / local Next: jump into the app (onboarding gate still applies).
 */
export default function HomePage() {
  if (isVercelRuntime()) {
    return <DownloadLanding initialPolicy={policyOrFallback()} />;
  }
  redirect("/tracker");
}
