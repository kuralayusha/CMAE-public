"use client";

import { useCallback, useState } from "react";

type Row = {
  company: string;
  role: string;
  status: string;
  tone: "ready" | "reply" | "follow" | "active" | "closed";
};

const INITIAL: Row[] = [
  {
    company: "Stripe",
    role: "Backend Engineer",
    status: "Ready to send",
    tone: "ready",
  },
  {
    company: "Vercel",
    role: "Product Engineer",
    status: "In progress",
    tone: "active",
  },
  {
    company: "Linear",
    role: "Full-stack",
    status: "Follow-up due",
    tone: "follow",
  },
];

const AFTER_SYNC: Row[] = [
  {
    company: "Stripe",
    role: "Backend Engineer",
    status: "Ready to send",
    tone: "ready",
  },
  {
    company: "Vercel",
    role: "Product Engineer",
    status: "Reply needed",
    tone: "reply",
  },
  {
    company: "Linear",
    role: "Full-stack",
    status: "Follow-up due",
    tone: "follow",
  },
  {
    company: "Notion",
    role: "Software Engineer",
    status: "Ready to send",
    tone: "ready",
  },
];

export function LandingTrackerDemo() {
  const [rows, setRows] = useState(INITIAL);
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(false);
  const [pulse, setPulse] = useState<number | null>(null);

  const runSync = useCallback(() => {
    if (syncing) return;
    setSyncing(true);
    setSynced(false);
    setPulse(0);
    let step = 0;
    const id = window.setInterval(() => {
      step += 1;
      setPulse(step);
      if (step >= 4) {
        window.clearInterval(id);
        setRows(AFTER_SYNC);
        setSyncing(false);
        setSynced(true);
        setPulse(null);
      }
    }, 380);
  }, [syncing]);

  return (
    <div className="cmae-land-tracker">
      <div className="cmae-land-tracker-bar">
        <div>
          <h3 className="cmae-land-tracker-title">Tracker</h3>
          <p className="cmae-land-tracker-sub">
            Applications, statuses, Gmail drafts — you send.
          </p>
        </div>
        <button
          type="button"
          className="cmae-land-cta is-primary"
          onClick={runSync}
          disabled={syncing}
        >
          {syncing ? "Syncing…" : synced ? "Sync again" : "Gmail sync"}
        </button>
      </div>

      <div className="cmae-land-tracker-table" role="table">
        <div className="cmae-land-tracker-row is-head" role="row">
          <span role="columnheader">Company</span>
          <span role="columnheader">Role</span>
          <span role="columnheader">Status</span>
        </div>
        {rows.map((row, i) => (
          <div
            key={`${row.company}-${i}`}
            className={`cmae-land-tracker-row${
              pulse === i + 1 ? " is-flash" : ""
            }${synced && i === 3 ? " is-new" : ""}`}
            role="row"
          >
            <span role="cell" className="cmae-land-tracker-co">
              {row.company}
            </span>
            <span role="cell">{row.role}</span>
            <span
              role="cell"
              className={`cmae-land-tracker-st is-${row.tone}`}
            >
              {row.status}
            </span>
          </div>
        ))}
      </div>
      <p className="cmae-land-demo-hint">
        {syncing
          ? "Incremental IMAP sync (demo)…"
          : synced
            ? "New mail merged — Notion appeared, Vercel needs a reply."
            : "Click Gmail sync to see statuses update."}
      </p>
    </div>
  );
}
