"use client";

import { useCallback, useMemo, useState } from "react";
import { useT } from "@/components/I18nProvider";
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

export function LandingTrackerDemo() {
  const t = useT();
  const { researchDone, markTrackerSynced } = useLandingScenario();
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(false);
  const [pulse, setPulse] = useState<number | null>(null);

  const statusLabel = useMemo(
    (): Record<TrackerStatus, string> => ({
      ready_to_send: t("landing.demo.statusReady"),
      needs_reply: t("landing.demo.statusReply"),
      follow_up_due: t("landing.demo.statusFollowUp"),
      in_progress: t("landing.demo.statusActive"),
    }),
    [t],
  );

  const initial = useMemo(
    (): Row[] => [
      {
        id: "umbrella",
        company: "Umbrella Co",
        role: t("landing.demo.roleSoftware"),
        status: "in_progress",
        label: statusLabel.in_progress,
        activity: t("landing.demo.activity2d"),
      },
      {
        id: "hooli",
        company: "Hooli",
        role: t("landing.demo.roleProduct"),
        status: "follow_up_due",
        label: statusLabel.follow_up_due,
        activity: t("landing.demo.activity5d"),
      },
      {
        id: "soylent",
        company: "Soylent Inc",
        role: t("landing.demo.roleFullstack"),
        status: "needs_reply",
        label: statusLabel.needs_reply,
        activity: t("landing.demo.activity1d"),
      },
    ],
    [statusLabel, t],
  );

  const afterSync = useMemo(
    (): Row[] => [
      {
        id: "acme",
        company: SCENARIO_COMPANIES[0]!.name,
        role: t(SCENARIO_COMPANIES[0]!.roleKey),
        status: "ready_to_send",
        label: statusLabel.ready_to_send,
        activity: t("landing.demo.activityJustNow"),
        isNew: true,
      },
      {
        id: "globex",
        company: SCENARIO_COMPANIES[1]!.name,
        role: t(SCENARIO_COMPANIES[1]!.roleKey),
        status: "ready_to_send",
        label: statusLabel.ready_to_send,
        activity: t("landing.demo.activityJustNow"),
        isNew: true,
      },
      {
        id: "initech",
        company: SCENARIO_COMPANIES[2]!.name,
        role: t(SCENARIO_COMPANIES[2]!.roleKey),
        status: "ready_to_send",
        label: statusLabel.ready_to_send,
        activity: t("landing.demo.activityJustNow"),
        isNew: true,
      },
      {
        id: "umbrella",
        company: "Umbrella Co",
        role: t("landing.demo.roleSoftware"),
        status: "in_progress",
        label: statusLabel.in_progress,
        activity: t("landing.demo.activity2d"),
      },
      {
        id: "hooli",
        company: "Hooli",
        role: t("landing.demo.roleProduct"),
        status: "needs_reply",
        label: statusLabel.needs_reply,
        activity: t("landing.demo.activityJustNow"),
      },
      {
        id: "soylent",
        company: "Soylent Inc",
        role: t("landing.demo.roleFullstack"),
        status: "needs_reply",
        label: statusLabel.needs_reply,
        activity: t("landing.demo.activity1d"),
      },
    ],
    [statusLabel, t],
  );

  const rows = synced ? afterSync : initial;

  const runSync = useCallback(() => {
    if (syncing) return;
    setSyncing(true);
    setSynced(false);
    markTrackerSynced(false);
    setPulse(null);
    let step = 0;
    const scanCount = initial.length;
    const id = window.setInterval(() => {
      step += 1;
      if (step <= scanCount) {
        setPulse(step);
        return;
      }
      window.clearInterval(id);
      setSyncing(false);
      setSynced(true);
      markTrackerSynced(true);
      setPulse(null);
    }, 380);
  }, [syncing, initial.length, markTrackerSynced]);

  return (
    <div className="cmae-land-demo">
      <div className="cmae-land-tracker-bar">
        <p className="cmae-land-demo-hint">
          {syncing
            ? t("landing.demo.trackerSyncing")
            : synced
              ? researchDone
                ? t("landing.demo.trackerSyncedWithResearch")
                : t("landing.demo.trackerSynced")
              : researchDone
                ? t("landing.demo.trackerReadyWithResearch")
                : t("landing.demo.trackerReady")}
        </p>
        <button
          type="button"
          className="cmae-land-cta is-primary"
          onClick={runSync}
          disabled={syncing}
        >
          {syncing
            ? t("landing.demo.trackerSyncingBtn")
            : synced
              ? t("landing.demo.trackerSyncAgain")
              : t("landing.demo.trackerSync")}
        </button>
      </div>

      <div className="cmae-land-inset cmae-land-tracker">
        <div className="cmae-land-tracker-table" role="table">
          <div className="cmae-land-tracker-row is-head" role="row">
            <span role="columnheader">{t("landing.demo.colCompany")}</span>
            <span role="columnheader">{t("landing.demo.colRole")}</span>
            <span role="columnheader">{t("landing.demo.colStatus")}</span>
            <span role="columnheader">{t("landing.demo.colActivity")}</span>
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
