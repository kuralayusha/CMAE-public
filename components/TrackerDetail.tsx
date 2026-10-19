"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useIntlLocale, useT } from "@/components/I18nProvider";
import { Button } from "@/components/ui";
import "./tracker-detail.css";

type DetailItem = {
  id: number;
  company: string;
  position: string | null;
  status: string;
  sentiment: string | null;
  waitingOn: string | null;
  primaryTo: string | null;
  researchJobId: string | null;
  workspaceFolder: string | null;
  lastOutboundAt: string | null;
  lastInboundAt: string | null;
  updatedAt: string;
};

type DetailMail = {
  id: number;
  folder: string;
  role: string;
  fromAddr: string;
  toAddr: string;
  subject: string;
  dateIso: string;
  snippet: string;
  gmailUrl: string;
};

type TimelineEvent = {
  id: string;
  at: string | null;
  title: string;
  kind: string;
  actors?: string[];
  confidence?: "high" | "medium" | "low";
  mailIds?: number[];
};

type TimelineData = {
  fingerprint: string;
  events: TimelineEvent[];
  origin: string;
  locale: string;
  mailCount: number;
  cached: boolean;
  model: string;
  updatedAt: string | null;
};

function formatDay(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const d = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return iso;
  try {
    return new Date(`${d}T12:00:00`).toLocaleDateString(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

function formatMailWhen(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleString(locale, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso.slice(0, 16);
  }
}

function mailFolderLabel(
  folder: string,
  t: (key: string) => string,
): string {
  if (folder === "INBOX") return t("mail.folder.inbox");
  if (folder === "SENT") return t("mail.folder.sent");
  return folder;
}

export function TrackerDetail({ itemId }: { itemId: number }) {
  const t = useT();
  const locale = useIntlLocale();
  const router = useRouter();
  const [item, setItem] = useState<DetailItem | null>(null);
  const [mails, setMails] = useState<DetailMail[]>([]);
  const [timeline, setTimeline] = useState<TimelineData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [loadingItem, setLoadingItem] = useState(true);
  const [loadingTimeline, setLoadingTimeline] = useState(true);
  const [showEmails, setShowEmails] = useState(false);

  const mailById = useMemo(() => {
    const map = new Map<number, DetailMail>();
    for (const m of mails) map.set(m.id, m);
    return map;
  }, [mails]);

  const loadItem = useCallback(async () => {
    setLoadingItem(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/tracker/${itemId}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || t("tracker.detailPage.notFound"));
      }
      setItem(data.item as DetailItem);
      setMails((data.mails || []) as DetailMail[]);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setItem(null);
      setMails([]);
    } finally {
      setLoadingItem(false);
    }
  }, [itemId, t]);

  const loadTimeline = useCallback(
    async (refresh = false) => {
      setLoadingTimeline(true);
      setTimelineError(null);
      try {
        const q = refresh ? "?refresh=1" : "";
        const res = await fetch(`/api/tracker/${itemId}/timeline${q}`);
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || t("tracker.detailPage.timelineError"));
        }
        setTimeline(data as TimelineData);
      } catch (err) {
        setTimelineError(err instanceof Error ? err.message : String(err));
        setTimeline(null);
      } finally {
        setLoadingTimeline(false);
      }
    },
    [itemId, t],
  );

  useEffect(() => {
    void loadItem();
  }, [loadItem]);

  useEffect(() => {
    if (!item) return;
    void loadTimeline(false);
  }, [item, loadTimeline]);

  if (loadingItem) {
    return (
      <div className="cmae-td">
        <p className="cmae-td-muted">{t("tracker.detailPage.loading")}</p>
      </div>
    );
  }

  if (loadError || !item) {
    return (
      <div className="cmae-td">
        <p className="cmae-td-error">
          {loadError || t("tracker.detailPage.notFound")}
        </p>
        <Button type="button" variant="ghost" onClick={() => router.push("/tracker")}>
          {t("tracker.detailPage.back")}
        </Button>
      </div>
    );
  }

  const chipKey = `tracker.chip.${item.status}`;
  const chip = t(chipKey);
  const statusLabel =
    chip === chipKey ? item.status.replace(/_/g, " ") : chip;

  return (
    <div className="cmae-td">
      <div className="cmae-td-toolbar">
        <Link href="/tracker" className="cmae-td-back">
          ← {t("tracker.detailPage.back")}
        </Link>
        <div className="cmae-td-toolbar-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={loadingTimeline}
            onClick={() => void loadTimeline(true)}
          >
            {t("tracker.detailPage.refresh")}
          </Button>
        </div>
      </div>

      <header className="cmae-td-header">
        <div className="cmae-td-header-main">
          <h2 className="cmae-td-company">{item.company}</h2>
          <p className="cmae-td-position">{item.position || "—"}</p>
        </div>
        <span className="cmae-status-chip" data-status={item.status}>
          {statusLabel}
        </span>
      </header>

      {item.primaryTo ? (
        <p className="cmae-td-meta">
          {t("tracker.detailPage.recipient")}: {item.primaryTo}
        </p>
      ) : null}

      <section className="cmae-td-section" aria-labelledby="cmae-td-timeline-h">
        <div className="cmae-td-section-head">
          <h3 id="cmae-td-timeline-h">{t("tracker.detailPage.timeline")}</h3>
          <div className="cmae-td-section-tools">
            {mails.length > 0 ? (
              <label
                className={`cmae-td-show-emails${showEmails ? " is-on" : ""}`}
              >
                <span className="cmae-td-show-emails-label">
                  {t("tracker.detailPage.showEmails")}
                </span>
                <button
                  type="button"
                  className={`cmae-tracker-switch-btn${showEmails ? " is-on" : ""}`}
                  role="switch"
                  aria-checked={showEmails}
                  aria-label={t("tracker.detailPage.showEmails")}
                  onClick={() => setShowEmails((v) => !v)}
                >
                  <span className="cmae-tracker-switch-knob" />
                </button>
              </label>
            ) : null}
            {timeline?.origin ? (
              <span className="cmae-td-origin" data-origin={timeline.origin}>
                {t(`tracker.detailPage.origin.${timeline.origin}`)}
              </span>
            ) : null}
          </div>
        </div>

        {loadingTimeline ? (
          <div className="cmae-td-skeleton" aria-busy="true">
            <div className="cmae-td-skel-line" />
            <div className="cmae-td-skel-line" />
            <div className="cmae-td-skel-line is-short" />
            <p className="cmae-td-muted">{t("tracker.detailPage.preparing")}</p>
          </div>
        ) : null}

        {!loadingTimeline && timelineError ? (
          <div className="cmae-td-error-box">
            <p>{timelineError}</p>
            <Button type="button" onClick={() => void loadTimeline(true)}>
              {t("tracker.detailPage.retry")}
            </Button>
          </div>
        ) : null}

        {!loadingTimeline && !timelineError && timeline ? (
          timeline.events.length === 0 ? (
            <p className="cmae-td-muted">{t("tracker.detailPage.emptyTimeline")}</p>
          ) : (
            <ol className={`cmae-td-timeline${showEmails ? " is-showing-mails" : ""}`}>
              {timeline.events.map((ev, idx) => {
                const childMails = (ev.mailIds || [])
                  .map((id) => mailById.get(id))
                  .filter((m): m is DetailMail => Boolean(m))
                  .sort((a, b) => a.dateIso.localeCompare(b.dateIso));
                return (
                  <li
                    key={`${ev.id}-${idx}`}
                    className="cmae-td-event"
                    data-kind={ev.kind}
                  >
                    <div className="cmae-td-event-rail" aria-hidden>
                      <span className="cmae-td-event-dot" />
                      {idx < timeline.events.length - 1 ? (
                        <span className="cmae-td-event-line" />
                      ) : null}
                    </div>
                    <div className="cmae-td-event-body">
                      <div className="cmae-td-event-meta">
                        <time className="cmae-td-event-date">
                          {ev.kind === "unknown_start" && !ev.at
                            ? t("tracker.detailPage.unknownDate")
                            : formatDay(ev.at, locale)}
                        </time>
                        {ev.confidence === "low" ? (
                          <span className="cmae-td-event-conf">
                            {t("tracker.detailPage.lowConfidence")}
                          </span>
                        ) : null}
                      </div>
                      <p className="cmae-td-event-title">{ev.title}</p>
                      {ev.actors?.length ? (
                        <p className="cmae-td-event-actors">
                          {ev.actors.join(" · ")}
                        </p>
                      ) : null}

                      {showEmails && childMails.length > 0 ? (
                        <ul className="cmae-td-event-mails">
                          {childMails.map((m) => (
                            <li key={m.id}>
                              <a
                                className="cmae-td-child-mail"
                                href={m.gmailUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                <span className="cmae-td-child-mail-when">
                                  {formatMailWhen(m.dateIso, locale)}
                                </span>
                                <span
                                  className="cmae-td-child-mail-from"
                                  title={m.fromAddr}
                                >
                                  {m.fromAddr}
                                </span>
                                <span
                                  className="cmae-td-child-mail-subject"
                                  title={m.subject}
                                >
                                  {m.subject || "—"}
                                </span>
                                <span className="cmae-td-child-mail-folder">
                                  {mailFolderLabel(m.folder, t)}
                                </span>
                              </a>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          )
        ) : null}
      </section>
    </div>
  );
}
