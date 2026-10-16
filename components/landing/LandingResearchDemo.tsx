"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SimTerminal, type SimLine } from "@/components/landing/SimTerminal";
import {
  SCENARIO_COMPANIES,
  useLandingScenario,
} from "@/components/landing/LandingScenario";

type Job = {
  id: string;
  url: string;
  title: string;
  folder: string;
  script: SimLine[];
  startDelayMs: number;
};

/** ~12 lines × ~250–280ms ≈ 3.2s script; stagger preserved from before. */
const JOBS: Job[] = [
  {
    id: "stripe",
    url: SCENARIO_COMPANIES[0]!.url,
    title: SCENARIO_COMPANIES[0]!.hostname,
    folder: SCENARIO_COMPANIES[0]!.folder,
    startDelayMs: 0,
    script: [
      { kind: "system", agent: "conductor", text: "◆ session · specialists: scout → jobfit → contact → research → writer → reviewer", delayMs: 220 },
      { kind: "system", agent: "conductor", text: "▶ dispatch → scout", delayMs: 180 },
      { kind: "curl", agent: "scout", text: "$ curl -sL https://stripe.com/jobs", delayMs: 280 },
      { kind: "system", agent: "scout", text: "↳ 184 KB · careers hub + 47 openings", delayMs: 240 },
      { kind: "think", agent: "scout", text: "route plan: /jobs, /jobs/engineering, /about", delayMs: 260 },
      { kind: "think", agent: "jobfit", text: "CV ↔ Backend Engineer — match score 84", delayMs: 280 },
      { kind: "think", agent: "contact", text: "Email pattern scan: stripe.com/jobs", delayMs: 240 },
      { kind: "ok", agent: "contact", text: "recommended: hiring@example.com", delayMs: 260 },
      { kind: "think", agent: "research", text: "external notes: payments infra, Connect, Treasury", delayMs: 260 },
      { kind: "ok", agent: "writer", text: "draft written → workspace/01-stripe/email_draft.md", delayMs: 280 },
      { kind: "think", agent: "reviewer", text: "scoring pack… threshold 72", delayMs: 220 },
      { kind: "ok", agent: "reviewer", text: "pack score 78 — keep", delayMs: 240 },
    ],
  },
  {
    id: "vercel",
    url: SCENARIO_COMPANIES[1]!.url,
    title: SCENARIO_COMPANIES[1]!.hostname,
    folder: SCENARIO_COMPANIES[1]!.folder,
    startDelayMs: 420,
    script: [
      { kind: "system", agent: "conductor", text: "◆ parallel URL slot 2 · vercel.com/careers", delayMs: 200 },
      { kind: "system", agent: "conductor", text: "▶ dispatch → scout", delayMs: 160 },
      { kind: "curl", agent: "scout", text: "$ curl -sL https://vercel.com/careers", delayMs: 270 },
      { kind: "system", agent: "scout", text: "↳ 96 KB · 12 open roles", delayMs: 230 },
      { kind: "think", agent: "scout", text: "routes: /careers, /blog, /about", delayMs: 250 },
      { kind: "think", agent: "jobfit", text: "CV ↔ Product Engineer — match score 88", delayMs: 270 },
      { kind: "think", agent: "contact", text: "Scanning text for emails and patterns", delayMs: 230 },
      { kind: "ok", agent: "contact", text: "recommended: talent@example.com", delayMs: 250 },
      { kind: "think", agent: "research", text: "stack notes: Next.js, Fluid compute, previews", delayMs: 260 },
      { kind: "ok", agent: "writer", text: "cold mail draft ready + CV attach name", delayMs: 270 },
      { kind: "think", agent: "reviewer", text: "check tone · contact · fit", delayMs: 200 },
      { kind: "ok", agent: "reviewer", text: "pack score 81 — keep", delayMs: 220 },
    ],
  },
  {
    id: "linear",
    url: SCENARIO_COMPANIES[2]!.url,
    title: SCENARIO_COMPANIES[2]!.hostname,
    folder: SCENARIO_COMPANIES[2]!.folder,
    startDelayMs: 780,
    script: [
      { kind: "system", agent: "conductor", text: "◆ parallel URL slot 3 · linear.app/careers", delayMs: 190 },
      { kind: "system", agent: "conductor", text: "▶ dispatch → scout", delayMs: 150 },
      { kind: "curl", agent: "scout", text: "$ curl -sL https://linear.app/careers", delayMs: 260 },
      { kind: "system", agent: "scout", text: "↳ 72 KB · 8 openings", delayMs: 220 },
      { kind: "think", agent: "scout", text: "careers page + team links queued", delayMs: 240 },
      { kind: "think", agent: "jobfit", text: "CV ↔ Full-stack — match score 91", delayMs: 260 },
      { kind: "think", agent: "contact", text: "↳ 2 candidates · jobs@example.com preferred", delayMs: 230 },
      { kind: "ok", agent: "contact", text: "recommended: jobs@example.com", delayMs: 240 },
      { kind: "think", agent: "research", text: "product craft: speed, keyboard UX, issue tracking", delayMs: 250 },
      { kind: "ok", agent: "writer", text: "draft → workspace/03-linear/email_draft.md", delayMs: 260 },
      { kind: "think", agent: "reviewer", text: "PASS check · no rewind", delayMs: 190 },
      { kind: "ok", agent: "reviewer", text: "pack score 86 — keep · workflow complete", delayMs: 210 },
    ],
  },
];

export function LandingResearchDemo() {
  const { markResearchDone, resetResearch } = useLandingScenario();
  const [runId, setRunId] = useState(0);
  const [running, setRunning] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const urls = JOBS.map((j) => j.url).join("\n");
  const finishedRef = useRef(false);

  const finished = running && doneCount >= JOBS.length;

  useEffect(() => {
    if (finished && !finishedRef.current) {
      finishedRef.current = true;
      markResearchDone();
    }
  }, [finished, markResearchDone]);

  const start = useCallback(() => {
    finishedRef.current = false;
    resetResearch();
    setDoneCount(0);
    setRunId((n) => n + 1);
    setRunning(true);
  }, [resetResearch]);

  const stop = useCallback(() => {
    finishedRef.current = false;
    setRunning(false);
    setDoneCount(0);
  }, []);

  return (
    <div className="cmae-land-demo">
      <p className="cmae-land-demo-hint">
        {running && !finished
          ? "Agents running in parallel…"
          : finished
            ? "Done — open Folders below to read briefs and drafts."
            : "Demo only — no network calls. Press Start research."}
      </p>

      <div className="cmae-land-inset">
        <div className="cmae-land-demo-research">
          <label className="cmae-land-demo-label" htmlFor="cmae-land-urls">
            Company / careers URLs
          </label>
          <textarea
            id="cmae-land-urls"
            className="cmae-land-demo-textarea"
            rows={3}
            value={urls}
            readOnly
            spellCheck={false}
            aria-readonly="true"
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
              <button type="button" className="cmae-land-cta" onClick={stop}>
                Stop demo
              </button>
            )}
          </div>
        </div>

        <div
          className={`cmae-land-demo-terms${running ? " is-live" : ""}`}
          aria-live="polite"
        >
          {running ? (
            JOBS.map((job) => (
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
          ) : (
            <p className="cmae-land-demo-empty">
              Press Start research — three agent terminals open and run in
              parallel.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
