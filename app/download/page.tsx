import type { Metadata } from "next";
import {
  loadBundledPolicy,
  type VersionPolicy,
} from "@/lib/version/policy";
import "./download.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Download CMAE",
  description: "Download the CMAE desktop app for macOS and Windows",
  robots: { index: false, follow: false },
};

export default function DownloadPage() {
  let policy: VersionPolicy;
  try {
    policy = loadBundledPolicy();
  } catch {
    policy = {
      latest: "0.0.0",
      minSupported: "0.0.0",
      force: false,
      releaseUrl: "https://github.com/kuralayusha/CMAE/releases/latest",
      downloads: {},
      notes: "",
    };
  }

  const macUrl = policy.downloads["darwin-arm64"] || policy.releaseUrl;
  const winUrl = policy.downloads["win32-x64"] || policy.releaseUrl;

  return (
    <main className="cmae-dl">
      <div className="cmae-dl-inner">
        <p className="cmae-dl-brand">CMAE</p>
        <h1 className="cmae-dl-title">Download</h1>
        <p className="cmae-dl-lead">
          Cold Mail AI Engine — desktop app for macOS (Apple Silicon) and
          Windows.
        </p>
        <p className="cmae-dl-meta">Version {policy.latest}</p>

        <div className="cmae-dl-actions">
          <a className="cmae-dl-btn is-primary" href={macUrl}>
            macOS (Apple Silicon)
            <span className="cmae-dl-btn-sub">.dmg</span>
          </a>
          <a className="cmae-dl-btn" href={winUrl}>
            Windows (x64)
            <span className="cmae-dl-btn-sub">.exe installer</span>
          </a>
        </div>

        <p className="cmae-dl-note">
          Files are served from{" "}
          <a href={policy.releaseUrl} className="cmae-dl-link">
            GitHub Releases
          </a>
          . After you tag a release, links update via{" "}
          <code>version-policy.json</code>. Mac builds are Developer ID signed
          and notarized.
        </p>

        {policy.notes ? (
          <pre className="cmae-dl-notes">{policy.notes}</pre>
        ) : null}
      </div>
    </main>
  );
}
