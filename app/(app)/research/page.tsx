"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ResearchHistory,
  type ResearchHistoryJob,
} from "@/components/ResearchHistory";
import { useT } from "@/components/I18nProvider";
import { PageHelpModal, usePageHelp } from "@/components/PageHelp";
import { Terminal } from "@/components/Terminal";
import { TopNav } from "@/components/TopNav";
import { Button } from "@/components/ui";

type JobCard = ResearchHistoryJob;

const LIVE = new Set(["queued", "running", "error"]);

export default function ResearchPage() {
  const t = useT();
  const help = usePageHelp("research");
  const [urls, setUrls] = useState("");
  const [history, setHistory] = useState<JobCard[]>([]);
  const [catalog, setCatalog] = useState<Record<string, JobCard>>({});
  const [panelIds, setPanelIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const upsertCatalog = useCallback((rows: JobCard[]) => {
    setCatalog((prev) => {
      const next = { ...prev };
      for (const j of rows) next[j.id] = { ...next[j.id], ...j };
      return next;
    });
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/research");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load jobs");

      const active: JobCard[] = data.active || data.jobs || [];
      const hist: JobCard[] = data.history || active;
      setHistory(hist);
      upsertCatalog([...hist, ...active]);

      // Only force-pin live jobs; error/done stay until the user closes them.
      setPanelIds((prev) => {
        const set = new Set(prev);
        for (const j of active) {
          if (j.status === "queued" || j.status === "running") set.add(j.id);
        }
        return [...set];
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [upsertCatalog]);

  useEffect(() => {
    void refreshJobs();
    const t = setInterval(() => void refreshJobs(), 4000);
    return () => clearInterval(t);
  }, [refreshJobs]);

  const panelJobs = useMemo(() => {
    return panelIds
      .map((id) => catalog[id])
      .filter(Boolean)
      .sort((a, b) => {
        const rank = (s: string) =>
          LIVE.has(s) ? (s === "running" || s === "queued" ? 0 : 1) : 2;
        const d = rank(a.status) - rank(b.status);
        if (d !== 0) return d;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
  }, [panelIds, catalog]);

  function openInPanel(job: JobCard) {
    setSelectedId(job.id);
    setPanelIds((prev) => (prev.includes(job.id) ? prev : [job.id, ...prev]));
    requestAnimationFrame(() => {
      document.getElementById(`term-${job.id}`)?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    });
  }

  function removeFromPanel(id: string) {
    setPanelIds((prev) => prev.filter((x) => x !== id));
    if (selectedId === id) setSelectedId(null);
  }

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start");
      const created: JobCard[] = data.jobs || [];
      upsertCatalog(created);
      setPanelIds((prev) => [...created.map((j) => j.id), ...prev]);
      setUrls("");
      await refreshJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cmae-research">
      <TopNav active="research" onHelp={help.reopen} />

      <div className="cmae-research-body">
        <ResearchHistory
          items={history}
          panelIds={panelIds}
          selectedId={selectedId}
          loading={loading}
          onSelect={openInPanel}
        />

        <main className="cmae-main">
          <div className="cmae-main-inner">
            <header className="cmae-page-head">
              <h1>{t("help.research.title")}</h1>
              <p>{t("help.research.subtitle")}</p>
            </header>

            <form className="cmae-start" onSubmit={start}>
              <textarea
                className="cmae-input"
                value={urls}
                onChange={(e) => setUrls(e.target.value)}
                rows={5}
                placeholder={t("research.placeholder")}
                style={{
                  fontFamily: "var(--font-mono), ui-monospace, monospace",
                  fontSize: 13,
                  resize: "vertical",
                  minHeight: 120,
                  height: "auto",
                  padding: "14px 14px",
                  letterSpacing: 0,
                  lineHeight: 1.55,
                }}
              />
              <div className="cmae-start-actions">
                <Button type="submit" disabled={busy || !urls.trim()}>
                  {busy ? t("research.starting") : t("research.start")}
                </Button>
              </div>
              {error ? <p className="cmae-error">{error}</p> : null}
            </form>

            <section className="cmae-panel">
              {loading && panelJobs.length === 0 ? (
                <p className="cmae-panel-empty">
                  {t("research.loadingTerminals")}
                </p>
              ) : panelJobs.length === 0 ? (
                <p className="cmae-panel-empty">{t("research.panelEmpty")}</p>
              ) : (
                <div className="term-grid">
                  {panelJobs.map((j) => (
                    <div key={j.id} id={`term-${j.id}`} className="term-slot">
                      {!LIVE.has(j.status) ? (
                        <div className="term-slot-bar">
                          <span>{t("research.pastSession")}</span>
                          <button
                            type="button"
                            onClick={() => removeFromPanel(j.id)}
                          >
                            {t("research.removeFromPanel")}
                          </button>
                        </div>
                      ) : null}
                      <Terminal
                        jobId={j.id}
                        url={j.url}
                        initialFolder={j.folderName}
                        onDismiss={() => removeFromPanel(j.id)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </main>
      </div>

      <PageHelpModal
        pageId="research"
        open={help.open}
        onClose={help.close}
      />
    </div>
  );
}
