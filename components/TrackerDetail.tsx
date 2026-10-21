"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useIntlLocale, useT } from "@/components/I18nProvider";
import { TruncateTip } from "@/components/TruncateTip";
import { Button } from "@/components/ui";
import { useTrackerItemEvents } from "@/lib/tracker/client-store";
import "./tracker-detail.css";

type RecipientOption = {
  email: string;
  role: string | null;
  priority: number | null;
  reason: string | null;
  recommended: boolean;
};

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
  userVersion?: number;
  recipientOptions?: RecipientOption[];
  recommendedTo?: string | null;
  unverified?: boolean;
  mailAfterClose?: boolean;
  channel?: string | null;
};

type GoneState = {
  reason: "merged" | "deleted";
  mergedIntoId?: number | null;
  deletedReason?: string | null;
  message: string;
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
  goneAt?: string | null;
  goneReason?: string | null;
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

const SHOW_EMAILS_KEY = "cmae.tracker.showEmails";

/** Default on; remember last choice in localStorage. */
function readShowEmailsPref(): boolean {
  try {
    const v = localStorage.getItem(SHOW_EMAILS_KEY);
    if (v === "0") return false;
    if (v === "1") return true;
  } catch {
    /* private mode / blocked */
  }
  return true;
}

function writeShowEmailsPref(on: boolean) {
  try {
    localStorage.setItem(SHOW_EMAILS_KEY, on ? "1" : "0");
  } catch {
    /* private mode / blocked */
  }
}

export type TrackerDetailProps = {
  itemId: number;
  /** `panel` hides back-link and uses close / in-place navigation. */
  variant?: "page" | "panel";
  onClose?: () => void;
  /** When a row was merged, open the survivor without leaving the list. */
  onOpenItem?: (id: number) => void;
};

export function TrackerDetail({
  itemId,
  variant = "page",
  onClose,
  onOpenItem,
}: TrackerDetailProps) {
  const t = useT();
  const locale = useIntlLocale();
  const router = useRouter();
  const isPanel = variant === "panel";
  const [item, setItem] = useState<DetailItem | null>(null);
  const [mails, setMails] = useState<DetailMail[]>([]);
  const [timeline, setTimeline] = useState<TimelineData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gone, setGone] = useState<GoneState | null>(null);
  const [mergeNotice, setMergeNotice] = useState<string | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [loadingItem, setLoadingItem] = useState(true);
  const [loadingTimeline, setLoadingTimeline] = useState(true);
  const [showEmails, setShowEmails] = useState(true);
  const [savingRecipient, setSavingRecipient] = useState(false);

  const goBack = useCallback(() => {
    if (isPanel && onClose) {
      onClose();
      return;
    }
    router.push("/tracker");
  }, [isPanel, onClose, router]);

  const openMerged = useCallback(
    (id: number) => {
      if (onOpenItem) {
        onOpenItem(id);
        return;
      }
      if (isPanel && onClose) {
        onClose();
        router.push(`/tracker/${id}`);
        return;
      }
      router.push(`/tracker/${id}`);
    },
    [isPanel, onClose, onOpenItem, router],
  );

  const redirectToMerged = useCallback(
    (id: number) => {
      if (onOpenItem) {
        onOpenItem(id);
        return;
      }
      router.replace(`/tracker/${id}`);
    },
    [onOpenItem, router],
  );

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
      if (res.status === 410) {
        if (data.reason === "merged" && data.mergedIntoId) {
          setMergeNotice(
            t("tracker.detailPage.mergedRedirect", { id: data.mergedIntoId }),
          );
          redirectToMerged(Number(data.mergedIntoId));
          return;
        }
        setGone({
          reason: data.reason === "merged" ? "merged" : "deleted",
          mergedIntoId: data.mergedIntoId,
          deletedReason: data.deletedReason,
          message:
            data.reason === "merged"
              ? t("tracker.detailPage.mergedGone")
              : t("tracker.detailPage.deletedReason", {
                  reason:
                    data.deletedReason === "folder_deleted"
                      ? t("tracker.detailPage.reasonFolderDeleted")
                      : data.deletedReason === "orphan"
                        ? t("tracker.detailPage.reasonOrphan")
                        : data.deletedReason ||
                          t("tracker.detailPage.reasonUnknown"),
                }),
        });
        setItem(null);
        setMails([]);
        return;
      }
      if (!res.ok) {
        throw new Error(data.error || t("tracker.detailPage.notFound"));
      }
      setGone(null);
      setItem(data.item as DetailItem);
      setMails((data.mails || []) as DetailMail[]);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setItem(null);
      setMails([]);
    } finally {
      setLoadingItem(false);
    }
  }, [itemId, t, redirectToMerged]);

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
    setShowEmails(readShowEmailsPref());
  }, []);

  useEffect(() => {
    void loadItem();
  }, [loadItem]);

  useTrackerItemEvents(itemId, (ev) => {
    if (ev.type === "merged" && ev.fromId === itemId && ev.intoId) {
      setMergeNotice(
        t("tracker.detailPage.mergedRedirect", { id: ev.intoId }),
      );
      redirectToMerged(ev.intoId);
      return;
    }
    if (ev.type === "deleted" && ev.itemId === itemId) {
      setGone({
        reason: "deleted",
        deletedReason: ev.reason,
        message: t("tracker.detailPage.deletedReason", {
          reason:
            ev.reason === "folder_deleted"
              ? t("tracker.detailPage.reasonFolderDeleted")
              : ev.reason === "orphan"
                ? t("tracker.detailPage.reasonOrphan")
                : ev.reason || t("tracker.detailPage.reasonUnknown"),
        }),
      });
      setItem(null);
      return;
    }
    void loadItem();
  });

  useEffect(() => {
    if (!item) return;
    void loadTimeline(false);
    // Reload timeline when the application id changes, not on recipient edits
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, loadTimeline]);

  async function changeRecipient(email: string) {
    if (!item || !email || email === item.primaryTo) return;
    setSavingRecipient(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/tracker/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          primaryTo: email,
          expectUserVersion: item.userVersion,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        code?: string;
        current?: number;
        primaryTo?: string;
        userVersion?: number;
        recipientOptions?: RecipientOption[];
        recommendedTo?: string | null;
      };
      if (res.status === 409 && data.code === "USER_VERSION_CONFLICT") {
        setLoadError(t("tracker.error.versionConflict"));
        await loadItem();
        return;
      }
      if (!res.ok) throw new Error(data.error || t("tracker.error.loadList"));
      setItem((prev) =>
        prev
          ? {
              ...prev,
              primaryTo: data.primaryTo || email,
              userVersion: data.userVersion ?? prev.userVersion,
              recipientOptions: data.recipientOptions ?? prev.recipientOptions,
              recommendedTo:
                data.recommendedTo !== undefined
                  ? data.recommendedTo
                  : prev.recommendedTo,
            }
          : prev,
      );
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRecipient(false);
    }
  }

  if (loadingItem && !gone) {
    return (
      <div className="cmae-td">
        <p className="cmae-td-muted">{t("tracker.detailPage.loading")}</p>
      </div>
    );
  }

  if (gone) {
    return (
      <div className="cmae-td">
        {mergeNotice ? (
          <p className="cmae-td-muted">{mergeNotice}</p>
        ) : null}
        <p className="cmae-td-error">{gone.message}</p>
        {gone.mergedIntoId ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => openMerged(gone.mergedIntoId!)}
          >
            {t("tracker.detailPage.openMerged")}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={goBack}>
          {isPanel ? t("common.close") : t("tracker.detailPage.back")}
        </Button>
      </div>
    );
  }

  if (loadError || !item) {
    return (
      <div className="cmae-td">
        <p className="cmae-td-error">
          {loadError || t("tracker.detailPage.notFound")}
        </p>
        <Button type="button" variant="ghost" onClick={goBack}>
          {isPanel ? t("common.close") : t("tracker.detailPage.back")}
        </Button>
      </div>
    );
  }

  const chipKey = `tracker.chip.${item.status}`;
  const chip = t(chipKey);
  const statusLabel =
    chip === chipKey ? item.status.replace(/_/g, " ") : chip;

  return (
    <div className={`cmae-td${isPanel ? " is-panel" : ""}`}>
      <div className="cmae-td-toolbar">
        {isPanel ? (
          <span className="cmae-td-toolbar-spacer" aria-hidden />
        ) : (
          <Link href="/tracker" className="cmae-td-back">
            ← {t("tracker.detailPage.back")}
          </Link>
        )}
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
          <h2 className="cmae-td-company">
            {item.company}
            {item.unverified ? (
              <span
                className="cmae-unverified-badge"
                title={t("tracker.unverifiedHint")}
              >
                {t("tracker.unverified")}
              </span>
            ) : null}
            {item.mailAfterClose ? (
              <span
                className="cmae-unverified-badge"
                title={t("tracker.mailAfterCloseHint")}
              >
                {t("tracker.mailAfterClose")}
              </span>
            ) : null}
          </h2>
          <p className="cmae-td-position">
            {item.position || "—"}
            {item.channel
              ? ` · ${t("tracker.viaChannel", { channel: item.channel })}`
              : ""}
          </p>
        </div>
        <span className="cmae-status-chip" data-status={item.status}>
          {statusLabel}
        </span>
      </header>

      {item.recipientOptions && item.recipientOptions.length > 1 ? (
        <p className="cmae-td-meta cmae-td-recipient">
          <label className="cmae-td-recipient-label">
            <span>{t("tracker.detailPage.recipient")}</span>
            <select
              className="cmae-tracker-recipient-select"
              value={
                item.primaryTo &&
                item.recipientOptions.some(
                  (o) =>
                    o.email.toLowerCase() === item.primaryTo!.toLowerCase(),
                )
                  ? item.recipientOptions.find(
                      (o) =>
                        o.email.toLowerCase() ===
                        item.primaryTo!.toLowerCase(),
                    )!.email
                  : item.recipientOptions.find((o) => o.recommended)?.email ||
                    item.recipientOptions[0]?.email ||
                    ""
              }
              disabled={savingRecipient}
              aria-label={t("tracker.recipient.aria", {
                company: item.company,
              })}
              onChange={(e) => {
                void changeRecipient(e.target.value);
              }}
            >
              {item.recipientOptions.map((opt) => {
                const base = opt.role
                  ? t("tracker.recipient.optionWithRole", {
                      email: opt.email,
                      role: opt.role,
                    })
                  : t("tracker.recipient.option", { email: opt.email });
                const label = opt.recommended
                  ? t("tracker.recipient.optionRecommended", { label: base })
                  : base;
                return (
                  <option key={opt.email} value={opt.email}>
                    {label}
                  </option>
                );
              })}
            </select>
          </label>
        </p>
      ) : item.primaryTo ? (
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
                  onClick={() => {
                    setShowEmails((v) => {
                      const next = !v;
                      writeShowEmailsPref(next);
                      return next;
                    });
                  }}
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
                                className={`cmae-td-child-mail${m.goneAt ? " is-gone" : ""}`}
                                href={m.gmailUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                <span className="cmae-td-child-mail-when">
                                  {formatMailWhen(m.dateIso, locale)}
                                </span>
                                <TruncateTip
                                  text={m.fromAddr}
                                  className="cmae-td-child-mail-from"
                                />
                                <TruncateTip
                                  text={m.subject || "—"}
                                  className="cmae-td-child-mail-subject"
                                />
                                <span className="cmae-td-child-mail-folder">
                                  {mailFolderLabel(m.folder, t)}
                                </span>
                                {m.goneAt ? (
                                  <span className="cmae-td-child-mail-gone">
                                    {t("tracker.detailPage.goneFromGmail")}
                                  </span>
                                ) : null}
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
