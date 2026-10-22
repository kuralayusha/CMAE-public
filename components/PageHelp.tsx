"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { HoverTip } from "@/components/HoverTip";
import { useT } from "@/components/I18nProvider";
import { type AppPageId, helpSeenKey } from "@/lib/help/pages";

/** Help control on the page title row — uses shared button styles so layout can’t collapse. */
export function PageHelpButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <HoverTip label={t("nav.helpTitle")}>
      <button
        type="button"
        className="cmae-btn cmae-btn-ghost cmae-page-help"
        onClick={onClick}
        aria-label={t("nav.helpAria")}
      >
        {t("nav.helpLabel")}
      </button>
    </HoverTip>
  );
}

/**
 * Self-contained help (button + modal). Keeps open-state local so clicking Help
 * does not re-render heavy page siblings (TrackerList, FolderBrowser, …).
 */
export function PageHelp({ pageId }: { pageId: AppPageId }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(helpSeenKey(pageId))) {
        setOpen(true);
      }
    } catch {
      /* private mode */
    }
  }, [pageId]);

  const close = useCallback(() => {
    try {
      localStorage.setItem(helpSeenKey(pageId), "1");
    } catch {
      /* ignore */
    }
    setOpen(false);
  }, [pageId]);

  const reopen = useCallback(() => {
    setOpen(true);
  }, []);

  return (
    <>
      <PageHelpButton onClick={reopen} />
      <PageHelpModal pageId={pageId} open={open} onClose={close} />
    </>
  );
}

/** @deprecated Prefer <PageHelp pageId=… /> so open-state stays local. */
export function usePageHelp(pageId: AppPageId) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(helpSeenKey(pageId))) {
        setOpen(true);
      }
    } catch {
      /* private mode */
    }
  }, [pageId]);

  const close = useCallback(() => {
    try {
      localStorage.setItem(helpSeenKey(pageId), "1");
    } catch {
      /* ignore */
    }
    setOpen(false);
  }, [pageId]);

  const reopen = useCallback(() => {
    setOpen(true);
  }, []);

  return { open, close, reopen };
}

export function PageHelpModal({
  pageId,
  open,
  onClose,
}: {
  pageId: AppPageId;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  const bodies = [0, 1, 2, 3]
    .map((i) => t(`help.${pageId}.helpBody${i}`))
    .filter((s) => s && !s.startsWith("help."));
  const steps = [0, 1, 2, 3, 4, 5]
    .map((i) => t(`help.${pageId}.helpStep${i}`))
    .filter((s) => s && !s.startsWith("help."));
  const statusesTitle = t(`help.${pageId}.helpStatusesTitle`);
  const statuses =
    statusesTitle && !statusesTitle.startsWith("help.")
      ? Array.from({ length: 16 }, (_, i) => {
          const label = t(`help.${pageId}.status${i}Label`);
          const text = t(`help.${pageId}.status${i}Text`);
          if (
            !label ||
            !text ||
            label.startsWith("help.") ||
            text.startsWith("help.")
          ) {
            return null;
          }
          return { label, text };
        }).filter((x): x is { label: string; text: string } => x != null)
      : [];

  return createPortal(
    <div
      className="cmae-help-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className={`cmae-help-modal${statuses.length ? " is-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`cmae-help-title-${pageId}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cmae-help-head">
          <h2 id={`cmae-help-title-${pageId}`}>
            {t(`help.${pageId}.helpTitle`)}
          </h2>
          <button
            type="button"
            className="cmae-help-close"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            ×
          </button>
        </header>
        <div className="cmae-help-body">
          {bodies.map((p) => (
            <p key={p}>{p}</p>
          ))}
          {statuses.length > 0 ? (
            <section className="cmae-help-statuses" aria-label={statusesTitle}>
              <h3 className="cmae-help-statuses-title">{statusesTitle}</h3>
              <dl className="cmae-help-status-list">
                {statuses.map((s) => (
                  <div key={s.label} className="cmae-help-status">
                    <dt>{s.label}</dt>
                    <dd>{s.text}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          {steps.length > 0 ? (
            <ol className="cmae-help-steps">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          ) : null}
        </div>
        <div className="cmae-help-actions">
          <button
            type="button"
            className="cmae-btn cmae-btn-primary"
            onClick={onClose}
          >
            {t("help.gotIt")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
