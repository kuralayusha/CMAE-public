"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  type AppPageId,
  PAGE_HELP,
  helpSeenKey,
} from "@/lib/help/pages";

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

  function close() {
    try {
      localStorage.setItem(helpSeenKey(pageId), "1");
    } catch {
      /* ignore */
    }
    setOpen(false);
  }

  function reopen() {
    setOpen(true);
  }

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
  const help = PAGE_HELP[pageId];
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

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

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="cmae-help-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="cmae-help-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`cmae-help-title-${pageId}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="cmae-help-head">
          <h2 id={`cmae-help-title-${pageId}`}>{help.helpTitle}</h2>
          <button
            type="button"
            className="cmae-help-close"
            onClick={onClose}
            aria-label="Kapat"
          >
            ×
          </button>
        </header>
        <div className="cmae-help-body">
          {help.helpBody.map((p) => (
            <p key={p}>{p}</p>
          ))}
          <ol className="cmae-help-steps">
            {help.helpSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
        <div className="cmae-help-actions">
          <button
            type="button"
            className="cmae-btn cmae-btn-primary"
            onClick={onClose}
          >
            Got it
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
