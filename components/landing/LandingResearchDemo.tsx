"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/components/I18nProvider";
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

export function LandingResearchDemo() {
  const t = useT();
  const { markResearchDone, resetResearch } = useLandingScenario();
  const [runId, setRunId] = useState(0);
  const [running, setRunning] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const finishedRef = useRef(false);

  const jobs: Job[] = useMemo(
    () => [
      {
        id: "acme",
        url: SCENARIO_COMPANIES[0]!.url,
        title: SCENARIO_COMPANIES[0]!.hostname,
        folder: SCENARIO_COMPANIES[0]!.folder,
        startDelayMs: 0,
        script: [
          { kind: "system", agent: "conductor", text: t("landing.sim.acmeSession"), delayMs: 220 },
          { kind: "system", agent: "conductor", text: t("landing.sim.dispatchScout"), delayMs: 180 },
          { kind: "curl", agent: "scout", text: t("landing.sim.acmeCurl"), delayMs: 280 },
          { kind: "system", agent: "scout", text: t("landing.sim.acmeBytes"), delayMs: 240 },
          { kind: "think", agent: "scout", text: t("landing.sim.acmeRoutes"), delayMs: 260 },
          { kind: "think", agent: "jobfit", text: t("landing.sim.acmeJobfit"), delayMs: 280 },
          { kind: "think", agent: "contact", text: t("landing.sim.acmeContactScan"), delayMs: 240 },
          { kind: "ok", agent: "contact", text: t("landing.sim.acmeContactOk"), delayMs: 260 },
          { kind: "think", agent: "research", text: t("landing.sim.acmeResearch"), delayMs: 260 },
          { kind: "ok", agent: "writer", text: t("landing.sim.acmeWriter"), delayMs: 280 },
          { kind: "think", agent: "reviewer", text: t("landing.sim.acmeReviewThink"), delayMs: 220 },
          { kind: "ok", agent: "reviewer", text: t("landing.sim.acmeReviewOk"), delayMs: 240 },
        ],
      },
      {
        id: "globex",
        url: SCENARIO_COMPANIES[1]!.url,
        title: SCENARIO_COMPANIES[1]!.hostname,
        folder: SCENARIO_COMPANIES[1]!.folder,
        startDelayMs: 420,
        script: [
          { kind: "system", agent: "conductor", text: t("landing.sim.globexSlot"), delayMs: 200 },
          { kind: "system", agent: "conductor", text: t("landing.sim.dispatchScout"), delayMs: 160 },
          { kind: "curl", agent: "scout", text: t("landing.sim.globexCurl"), delayMs: 270 },
          { kind: "system", agent: "scout", text: t("landing.sim.globexBytes"), delayMs: 230 },
          { kind: "think", agent: "scout", text: t("landing.sim.globexRoutes"), delayMs: 250 },
          { kind: "think", agent: "jobfit", text: t("landing.sim.globexJobfit"), delayMs: 270 },
          { kind: "think", agent: "contact", text: t("landing.sim.globexContactScan"), delayMs: 230 },
          { kind: "ok", agent: "contact", text: t("landing.sim.globexContactOk"), delayMs: 250 },
          { kind: "think", agent: "research", text: t("landing.sim.globexResearch"), delayMs: 260 },
          { kind: "ok", agent: "writer", text: t("landing.sim.globexWriter"), delayMs: 270 },
          { kind: "think", agent: "reviewer", text: t("landing.sim.globexReviewThink"), delayMs: 200 },
          { kind: "ok", agent: "reviewer", text: t("landing.sim.globexReviewOk"), delayMs: 220 },
        ],
      },
      {
        id: "initech",
        url: SCENARIO_COMPANIES[2]!.url,
        title: SCENARIO_COMPANIES[2]!.hostname,
        folder: SCENARIO_COMPANIES[2]!.folder,
        startDelayMs: 780,
        script: [
          { kind: "system", agent: "conductor", text: t("landing.sim.initechSlot"), delayMs: 190 },
          { kind: "system", agent: "conductor", text: t("landing.sim.dispatchScout"), delayMs: 150 },
          { kind: "curl", agent: "scout", text: t("landing.sim.initechCurl"), delayMs: 260 },
          { kind: "system", agent: "scout", text: t("landing.sim.initechBytes"), delayMs: 220 },
          { kind: "think", agent: "scout", text: t("landing.sim.initechRoutes"), delayMs: 240 },
          { kind: "think", agent: "jobfit", text: t("landing.sim.initechJobfit"), delayMs: 260 },
          { kind: "think", agent: "contact", text: t("landing.sim.initechContactScan"), delayMs: 230 },
          { kind: "ok", agent: "contact", text: t("landing.sim.initechContactOk"), delayMs: 240 },
          { kind: "think", agent: "research", text: t("landing.sim.initechResearch"), delayMs: 250 },
          { kind: "ok", agent: "writer", text: t("landing.sim.initechWriter"), delayMs: 260 },
          { kind: "think", agent: "reviewer", text: t("landing.sim.initechReviewThink"), delayMs: 190 },
          { kind: "ok", agent: "reviewer", text: t("landing.sim.initechReviewOk"), delayMs: 210 },
        ],
      },
    ],
    [t],
  );

  const urls = jobs.map((j) => j.url).join("\n");
  const finished = running && doneCount >= jobs.length;

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
          ? t("landing.demo.researchRunning")
          : finished
            ? t("landing.demo.researchDone")
            : t("landing.demo.researchIdle")}
      </p>

      <div className="cmae-land-inset">
        <div className="cmae-land-demo-research">
          <label className="cmae-land-demo-label" htmlFor="cmae-land-urls">
            {t("landing.demo.researchUrlsLabel")}
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
                {finished
                  ? t("landing.demo.researchAgain")
                  : t("landing.demo.researchStart")}
              </button>
            ) : (
              <button type="button" className="cmae-land-cta" onClick={stop}>
                {t("landing.demo.researchStop")}
              </button>
            )}
          </div>
        </div>

        <div
          className={`cmae-land-demo-terms${running ? " is-live" : ""}`}
          aria-live="polite"
        >
          {running ? (
            jobs.map((job) => (
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
              {t("landing.demo.researchEmpty")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
