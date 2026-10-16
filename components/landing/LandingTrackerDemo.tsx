"use client";

import { useCallback, useState } from "react";
import {
  SCENARIO_COMPANIES,
  useLandingScenario,
} from "@/components/landing/LandingScenario";

type TrackerStatus =
  | "ready_to_send"
  | "needs_reply"
  | "follow_up_due"
  | "in_progress";

type Row = {
  id: string;
  company: string;
  role: string;
  status: TrackerStatus;
  label: string;
  activity: string;
  isNew?: boolean;
};

const STATUS_LABEL: Record<TrackerStatus, string> = {
  ready_to_send: "Ready to send",
  needs_reply: "Reply needed",
  follow_up_due: "Follow-up due",
  in_progress: "Active",
};

const INITIAL: Row[] = [
  {
    id: "notion",
    company: "Notion",
    role: "Software Engineer",
    status: "in_progress",
    label: STATUS_LABEL.in_progress,
    activity: "2d ago",
  },
  {
    id: "figma",
    company: "Figma",
    role: "Product Engineer",
    status: "follow_up_due",
    label: STATUS_LABEL.follow_up_due,
    activity: "5d ago",
  },
  {
    id: "anthropic",
    company: "Anthropic",
    role: "Full-stack",
    status: "needs_reply",
    label: STATUS_LABEL.needs_reply,
    activity: "1d ago",
  },
];

const AFTER_SYNC: Row[] = [
  {
    id: "stripe",
    company: SCENARIO_COMPANIES[0]!.name,
    role: SCENARIO_COMPANIES[0]!.role,
    status: "ready_to_send",
    label: STATUS_LABEL.ready_to_send,
    activity: "just now",
    isNew: true,
  },
  {
    id: "vercel",
    company: SCENARIO_COMPANIES[1]!.name,
    role: SCENARIO_COMPANIES[1]!.role,
    status: "ready_to_send",
    label: STATUS_LABEL.ready_to_send,
    activity: "just now",
    isNew: true,
  },
  {
    id: "linear",
    company: SCENARIO_COMPANIES[2]!.name,
    role: SCENARIO_COMPANIES[2]!.role,
    status: "ready_to_send",
    label: STATUS_LABEL.ready_to_send,
    activity: "just now",
    isNew: true,
  },
  {
    id: "notion",
    company: "Notion",
    role: "Software Engineer",
    status: "in_progress",
    label: STATUS_LABEL.in_progress,
    activity: "2d ago",
  },
  {
    id: "figma",
    company: "Figma",
    role: "Product Engineer",
    status: "needs_reply",
    label: STATUS_LABEL.needs_reply,
    activity: "just now",
  },
  {
    id: "anthropic",
    company: "Anthropic",
    role: "Full-stack",
    status: "needs_reply",
    label: STATUS_LABEL.needs_reply,
    activity: "1d ago",
  },
];

export function LandingTrackerDemo() {
  const { researchDone, markTrackerSynced } = useLandingScenario();
  const [rows, setRows] = useState(INITIAL);
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(false);
  const [pulse, setPulse] = useState<number | null>(null);

  const runSync = useCallback(() => {
    if (syncing) return;
    setSyncing(true);
    setSynced(false);
    markTrackerSynced(false);
    setPulse(null);
    let step = 0;
    const scanCount = rows.length;
    const id = window.setInterval(() => {
      step += 1;
      if (step <= scanCount) {
        setPulse(step);
        return;
      }
      window.clearInterval(id);
      setRows(AFTER_SYNC);
      setSyncing(false);
      setSynced(true);
      markTrackerSynced(true);
      setPulse(null);
    }, 380);
  }, [syncing, rows.length, markTrackerSynced]);

  return (
    <div className="cmae-land-demo">
      <div className="cmae-land-tracker-bar">
        <p className="cmae-land-demo-hint">
          {syncing
            ? "Scanning inbox — merging threads…"
            : synced
              ? researchDone
                ? "Stripe, Vercel, and Linear landed as Ready to send. Figma moved to Reply needed."
                : "Stripe, Vercel, and Linear appeared as Ready to send. Figma moved to Reply needed."
              : researchDone
                ? "Click Gmail sync — your three researched companies join as Ready to send."
                : "Existing conversations stay. Click Gmail sync to pull in the Search companies."}
        </p>
        <button
          type="button"
          className="cmae-land-cta is-primary"
          onClick={runSync}
          disabled={syncing}
        >
          {syncing ? "Syncing…" : synced ? "Sync again" : "Gmail sync"}
        </button>
      </div>

      <div className="cmae-land-inset cmae-land-tracker">
        <div className="cmae-land-tracker-table" role="table">
          <div className="cmae-land-tracker-row is-head" role="row">
            <span role="columnheader">Company</span>
            <span role="columnheader">Role</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Activity</span>
          </div>
          {rows.map((row, i) => (
            <div
              key={row.id}
              className={`cmae-land-tracker-row${
                pulse === i + 1 ? " is-flash" : ""
              }${synced && row.isNew ? " is-new" : ""}`}
              role="row"
            >
              <span role="cell" className="cmae-land-tracker-co">
                {row.company}
              </span>
              <span role="cell">{row.role}</span>
              <span role="cell" className="cmae-land-tracker-status-cell">
                <span className="cmae-status-chip" data-status={row.status}>
                  {row.label}
                </span>
              </span>
              <span role="cell" className="cmae-land-tracker-act">
                {row.activity}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
