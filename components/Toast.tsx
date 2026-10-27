"use client";

import { useCallback, useEffect, useRef } from "react";
import { useT } from "@/components/I18nProvider";
import { AlertIcon, CheckIcon, XIcon } from "@/components/icons";
import "./toast.css";

const AUTO_CLOSE_MS = 4500;

/**
 * Transient message that dismisses itself after a few seconds (timer pauses
 * while hovered) and can be closed by hand. Remount it (change `key`) to show
 * a new message — an identical repeat then replays the timer.
 */
export function Toast({
  message,
  tone,
  onClose,
}: {
  message: string;
  tone: "ok" | "err";
  onClose: () => void;
}) {
  const t = useT();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const start = useCallback(() => {
    stop();
    timer.current = setTimeout(() => closeRef.current(), AUTO_CLOSE_MS);
  }, [stop]);

  useEffect(() => {
    start();
    return stop;
  }, [start, stop]);

  return (
    <div
      className={`cmae-toast is-${tone}`}
      role={tone === "err" ? "alert" : "status"}
      onMouseEnter={stop}
      onMouseLeave={start}
    >
      <span className="cmae-toast-icon">
        {tone === "ok" ? <CheckIcon size={16} /> : <AlertIcon size={16} />}
      </span>
      <span className="cmae-toast-text">{message}</span>
      <button
        type="button"
        className="cmae-toast-close"
        onClick={onClose}
        aria-label={t("common.close")}
        title={t("common.close")}
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}
