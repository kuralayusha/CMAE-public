"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useT } from "@/components/I18nProvider";
import { Terminal } from "@/components/Terminal";

export default function LiveTerminalPage() {
  const t = useT();
  const params = useParams<{ jobId: string }>();
  const jobId = params.jobId;
  const [url, setUrl] = useState<string | null>(null);
  const [folderName, setFolderName] = useState<(string | undefined)>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/research/${jobId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || t("research.error.jobNotFound"));
        if (!alive) return;
        setUrl(data.url);
        setFolderName(data.folderName);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [jobId, t]);

  if (error) {
    return (
      <div className="term-live-page">
        <p style={{ color: "#e5e5e5", fontFamily: "var(--font-mono), monospace", padding: 24 }}>{error}</p>
      </div>
    );
  }

  if (!url) {
    return (
      <div className="term-live-page">
        <p style={{ color: "#737373", fontFamily: "var(--font-mono), monospace", padding: 24 }}>
          {t("research.loadingTerminal")}
        </p>
      </div>
    );
  }

  return (
    <div className="term-live-page">
      <Terminal
        jobId={jobId}
        url={url}
        initialFolder={folderName}
        hideChromeButtons
        fullscreen
      />
    </div>
  );
}
