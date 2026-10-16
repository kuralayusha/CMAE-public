"use client";

import type { ReactNode } from "react";

type Props = {
  step: string;
  title: string;
  lead: string;
  children: ReactNode;
};

/**
 * White step copy (right-aligned) + light-gray demo band.
 * Interactive UI lives in a dark inset inside each demo.
 */
export function LandingStage({ step, title, lead, children }: Props) {
  return (
    <section
      className="cmae-land-stage"
      aria-labelledby={`cmae-land-stage-${step}`}
    >
      <div className="cmae-land-stage-head">
        <p className="cmae-land-stage-step">
          <span className="cmae-land-stage-n">{step}</span>
          <span className="cmae-land-stage-t" id={`cmae-land-stage-${step}`}>
            {title}
          </span>
        </p>
        <p className="cmae-land-stage-lead">{lead}</p>
      </div>
      <div className="cmae-land-stage-panel">
        <div className="cmae-land-stage-body">{children}</div>
      </div>
    </section>
  );
}
