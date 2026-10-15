"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useLocaleUpper, useT } from "@/components/I18nProvider";
import type { SyncLogKind, SyncLogLine } from "@/lib/tracker/types";

type SyncTermStatus = "running" | "done" | "error" | "canceled";

type Props = {
  lines: SyncLogLine[];
  status: SyncTermStatus;
  onCancel?: () => void;
  onDismiss?: () => void;
};

const KIND_COLOR: Record<SyncLogKind, string> = {
  think: "#94a3b8",
  system: "#fbbf24",
  ok: "#4ade80",
  err: "#f87171",
  curl: "#38bdf8",
};

export function SyncTerminal({ lines, status, onCancel, onDismiss }: Props) {
  const t = useT();
  const upper = useLocaleUpper();
  const [stuckBottom, setStuckBottom] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (collapsed || !stuckBottom || !scroller.current) return;
    scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [lines, stuckBottom, collapsed]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStuckBottom(dist < 40);
  }

  const canCancel = status === "running" && Boolean(onCancel);
  const canDismiss = status !== "running" && Boolean(onDismiss);

  function onRedClick() {
    if (canCancel) onCancel?.();
    else if (canDismiss) onDismiss?.();
  }

  return (
    <div
      className={`term-window term-window-sync${collapsed ? " term-window-collapsed" : ""}`}
    >
      <div className="term-titlebar">
        <div className="term-tls" role="group" aria-label={t("terminal.ariaSync")}>
          <button
            type="button"
            className="term-tl term-tl-close"
            title={
              canCancel
                ? t("terminal.cancelSync")
                : canDismiss
                  ? t("terminal.close")
                  : undefined
            }
            aria-label={canCancel ? t("terminal.cancel") : t("terminal.close")}
            disabled={!canCancel && !canDismiss}
            onClick={onRedClick}
            style={{
              ...DOT_HIT,
              opacity: canCancel || canDismiss ? 1 : 0.35,
            }}
          >
            <span
              aria-hidden
              className="term-tl-face"
              style={{ ...DOT_FACE, backgroundColor: DOT_CLOSE }}
            />
          </button>
          <button
            type="button"
            className="term-tl term-tl-min"
            title={collapsed ? t("terminal.expand") : t("terminal.collapse")}
            aria-label={collapsed ? t("terminal.expand") : t("terminal.collapse")}
            onClick={() => setCollapsed((c) => !c)}
            style={DOT_HIT}
          >
            <span
              aria-hidden
              className="term-tl-face"
              style={{ ...DOT_FACE, backgroundColor: DOT_MIN }}
            />
          </button>
        </div>
        <div className="term-title">
          <span className="term-title-main">{t("tracker.sync")}</span>
          <span className="term-title-sub">{t("sync.subtitle")}</span>
        </div>
        <div className={`term-status term-status-${status}`}>
          {status === "running" ? <span className="term-pulse" /> : null}
          {upper(t(`terminal.status.${status}`))}
        </div>
      </div>

      {!collapsed ? (
        <div
          className="term-body term-body-simple term-body-sync"
          ref={scroller}
          onScroll={onScroll}
        >
          {lines.length === 0 ? (
            <div className="term-line" style={{ color: "#64748b" }}>
              {t("sync.waiting")}
            </div>
          ) : null}
          {lines.map((line) => (
            <div
              key={line.id}
              className={`term-line term-line-simple term-kind-${line.kind}`}
              style={{ color: KIND_COLOR[line.kind] }}
            >
              <span className="term-stamp">{formatStamp(line.at)}</span>
              <span className="term-line-main">{line.text}</span>
            </div>
          ))}
          {status === "running" ? (
            <div className="term-cursor-row">
              <span className="term-cursor" />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatStamp(at: number) {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

const DOT_CLOSE = "#ff5f57";
const DOT_MIN = "#febc2e";

const DOT_HIT: CSSProperties = {
  width: 12,
  height: 12,
  minWidth: 12,
  minHeight: 12,
  padding: 0,
  margin: 0,
  border: "none",
  borderRadius: "50%",
  background: "transparent",
  cursor: "pointer",
  flexShrink: 0,
  appearance: "none",
  WebkitAppearance: "none",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  lineHeight: 0,
};

const DOT_FACE: CSSProperties = {
  display: "block",
  width: 12,
  height: 12,
  borderRadius: "50%",
  border: "none",
  boxShadow: "none",
  flexShrink: 0,
};
