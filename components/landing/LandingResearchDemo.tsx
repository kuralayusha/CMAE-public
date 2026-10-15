"use client";

import { useCallback, useState } from "react";
import { SimTerminal, type SimLine } from "@/components/landing/SimTerminal";

type Job = {
  id: string;
  url: string;
  title: string;
  folder: string;
  script: SimLine[];
  startDelayMs: number;
};

const JOBS: Job[] = [
  {
    id: "a",
    url: "https://stripe.com/jobs",
    title: "stripe.com",
    folder: "01-stripe",
    startDelayMs: 0,
    script: [
      { kind: "system", agent: "conductor", text: "scout → jobfit → contact", delayMs: 280 },
      { kind: "curl", agent: "scout", text: "GET /jobs — 47 openings", delayMs: 520 },
      { kind: "think", agent: "jobfit", text: "match score 84 (backend)", delayMs: 640 },
      { kind: "ok", agent: "contact", text: "found hiring@example.com", delayMs: 580 },
      { kind: "python", agent: "writer", text: "draft → Gmail Drafts", delayMs: 700 },
      { kind: "ok", agent: "reviewer", text: "pack score 78 — keep", delayMs: 480 },
    ],
  },
  {
    id: "b",
    url: "https://vercel.com/careers",
    title: "vercel.com",
    folder: "02-vercel",
    startDelayMs: 420,
    script: [
      { kind: "system", agent: "conductor", text: "parallel URL slot 2", delayMs: 260 },
      { kind: "curl", agent: "scout", text: "GET /careers — 12 roles", delayMs: 500 },
      { kind: "think", agent: "research", text: "stack: Next.js, Fluid", delayMs: 620 },
      { kind: "ok", agent: "contact", text: "talent@example.com", delayMs: 540 },
      { kind: "python", agent: "writer", text: "cold mail draft ready", delayMs: 680 },
      { kind: "ok", agent: "reviewer", text: "pack score 81 — keep", delayMs: 420 },
    ],
  },
  {
    id: "c",
    url: "https://linear.app/careers",
    title: "linear.app",
    folder: "03-linear",
    startDelayMs: 780,
    script: [
      { kind: "system", agent: "conductor", text: "parallel URL slot 3", delayMs: 240 },
      { kind: "curl", agent: "scout", text: "GET /careers — 8 roles", delayMs: 480 },
      { kind: "think", agent: "jobfit", text: "match score 91 (product eng)", delayMs: 600 },
      { kind: "ok", agent: "contact", text: "jobs@example.com", delayMs: 520 },
      { kind: "python", agent: "writer", text: "draft + CV attach name", delayMs: 660 },
      { kind: "ok", agent: "reviewer", text: "pack score 86 — keep", delayMs: 400 },
    ],
  },
];

export function LandingResearchDemo() {
  const [runId, setRunId] = useState(0);
  const [running, setRunning] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const [urls, setUrls] = useState(
    JOBS.map((j) => j.url).join("\n"),
  );

  const finished = running && doneCount >= JOBS.length;

  const start = useCallback(() => {
    setDoneCount(0);
    setRunId((n) => n + 1);
    setRunning(true);
  }, []);

  const reset = useCallback(() => {
    setRunning(false);
    setDoneCount(0);
  }, []);

  return (
    <div className="cmae-land-demo">
      <div className="cmae-land-demo-chrome">
        <div className="cmae-land-demo-nav" aria-hidden>
          <span className="cmae-land-demo-brand">CMAE</span>
          <span>Tracker</span>
          <span className="is-active">Search</span>
          <span>Folders</span>
          <span>Settings</span>
        </div>
        <div className="cmae-land-demo-search">
          <label className="cmae-land-demo-label" htmlFor="cmae-land-urls">
            Company / careers URLs
          </label>
          <textarea
            id="cmae-land-urls"
            className="cmae-land-demo-textarea"
            rows={3}
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            disabled={running && !finished}
            spellCheck={false}
          />
          <div className="cmae-land-demo-actions">
            {!running || finished ? (
              <button
                type="button"
                className="cmae-land-cta is-primary"
                onClick={start}
              >
                {finished ? "Run again" : "Start research"}
              </button>
            ) : (
              <button
                type="button"
                className="cmae-land-cta"
                onClick={reset}
              >
                Stop demo
              </button>
            )}
            <span className="cmae-land-demo-hint">
              {running && !finished
                ? "Agents running in parallel…"
                : finished
                  ? "Done — drafts would land in Gmail Drafts."
                  : "Demo only — no network calls."}
            </span>
          </div>
        </div>
      </div>

      <div
        className={`cmae-land-demo-terms${running ? " is-live" : ""}`}
        aria-live="polite"
      >
        {running
          ? JOBS.map((job) => (
              <SimTerminal
                key={`${runId}-${job.id}`}
                url={job.url}
                title={job.title}
                folder={job.folder}
                script={job.script}
                startDelayMs={job.startDelayMs}
                running={running}
                onDone={() => setDoneCount((n) => n + 1)}
              />
            ))
          : (
            <p className="cmae-land-demo-empty">
              Press Start research — three agent terminals open and run in
              parallel.
            </p>
          )}
      </div>
    </div>
  );
}
