"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useLocaleUpper, useT } from "@/components/I18nProvider";
import { derivePlain } from "@/lib/research/plain";
import type { JobStatus, TermKind, TermLine } from "@/lib/research/types";

type Props = {
  jobId: string;
  url: string;
  initialFolder?: string;
  hideChromeButtons?: boolean;
  fullscreen?: boolean;
  /** Close / remove terminal from panel when job is finished (done / error / canceled). */
  onDismiss?: () => void;
};

type LogMode = "simple" | "detail";

/** Classic ANSI-ish log colors — body only; chrome stays mono */
const KIND_COLOR: Record<TermKind, string> = {
  think: "#94a3b8",
  curl: "#38bdf8",
  python: "#c084fc",
  system: "#fbbf24",
  ok: "#4ade80",
  err: "#f87171",
};

const AGENT_COLOR: Record<string, string> = {
  scout: "#38bdf8",
  jobfit: "#a78bfa",
  contact: "#f472b6",
  research: "#2dd4bf",
  writer: "#fbbf24",
  reviewer: "#fb923c",
  conductor: "#94a3b8",
};

export function Terminal({
  jobId,
  url,
  initialFolder,
  hideChromeButtons = false,
  fullscreen = false,
  onDismiss,
}: Props) {
  const t = useT();
  const upper = useLocaleUpper();
  const [lines, setLines] = useState<TermLine[]>([]);
  const [status, setStatus] = useState<JobStatus>("queued");
  const [folderName, setFolderName] = useState(
    initialFolder || "",
  );
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [stuckBottom, setStuckBottom] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [logMode, setLogMode] = useState<LogMode>("simple");
  const scroller = useRef<HTMLDivElement>(null);

  const statusLabel = upper(t(`terminal.status.${status}`));

  useEffect(() => {
    const es = new EventSource(`/api/research/${jobId}/stream`);
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as {
          type: string;
          line?: TermLine;
          status?: JobStatus;
          companyName?: string | null;
          folderName?: string;
          job?: {
            status: JobStatus;
            folderName: string;
            companyName: string | null;
          };
        };
        if (data.type === "hello" && data.job) {
          setStatus(data.job.status);
          setFolderName(data.job.folderName);
          setCompanyName(data.job.companyName);
        }
        if (data.type === "line" && data.line) {
          setLines((prev) => [...prev, data.line!]);
        }
        if (data.type === "status" && data.status) {
          setStatus(data.status);
          if (data.companyName) setCompanyName(data.companyName);
          if (data.folderName) setFolderName(data.folderName);
        }
        if (data.type === "done" && data.status) {
          setStatus(data.status);
          es.close();
        }
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [jobId]);

  const displayLines = useMemo(() => {
    if (logMode === "detail") {
      return lines.map((line) => ({
        id: line.id,
        kind: line.kind,
        color: KIND_COLOR[line.kind],
        stamp: formatStamp(line.at),
        text: line.text,
        agentHint: null as string | null,
        agent: line.agent ?? guessAgentFromText(line.text),
      }));
    }

    const out: {
      id: string;
      kind: TermKind;
      color: string;
      stamp: string;
      text: string;
      agentHint: string | null;
      agent: string | null;
    }[] = [];
    let lastPlain = "";
    for (const line of lines) {
      const plain =
        line.plain ||
        derivePlain({ kind: line.kind, text: line.text, agent: line.agent });
      if (!plain) continue;
      if (plain === lastPlain) continue;
      lastPlain = plain;
      const { body, agentHint } = splitAgentParen(plain);
      const simpleKind: TermKind =
        line.kind === "err" ? "err" : line.kind === "ok" ? "ok" : "think";
      out.push({
        id: line.id,
        kind: simpleKind,
        color:
          simpleKind === "err"
            ? KIND_COLOR.err
            : simpleKind === "ok"
              ? KIND_COLOR.ok
              : KIND_COLOR.think,
        stamp: formatStamp(line.at),
        text: body,
        agentHint,
        agent: line.agent ?? guessAgentFromText(line.text),
      });
    }
    return out;
  }, [lines, logMode]);

  useEffect(() => {
    if (collapsed || !stuckBottom || !scroller.current) return;
    scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [displayLines, stuckBottom, collapsed, logMode]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStuckBottom(dist < 40);
  }

  function openFullscreen() {
    window.open(`/research/live/${jobId}`, "_blank", "noopener,noreferrer");
  }

  async function confirmCancel() {
    setCancelBusy(true);
    try {
      const res = await fetch(`/api/research/${jobId}/cancel`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Cancel failed");
      if (data.folderName) setFolderName(data.folderName);
      setStatus("canceled");
      setConfirmOpen(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelBusy(false);
    }
  }

  const title = companyName || safeHost(url);
  const canCancel = status === "queued" || status === "running";
  const canDismiss = !canCancel && Boolean(onDismiss);

  return (
    <>
      <div
        className={`term-window${collapsed ? " term-window-collapsed" : ""}${
          fullscreen ? " term-window-fullscreen" : ""
        }`}
      >
        <div className="term-titlebar">
          {!hideChromeButtons ? (
            <div
              className="term-tls"
              role="group"
              aria-label={t("terminal.ariaControls")}
            >
              <button
                type="button"
                className="term-tl term-tl-close"
                title={
                  canCancel
                    ? t("terminal.cancel")
                    : canDismiss
                      ? t("terminal.close")
                      : t("terminal.cancel")
                }
                aria-label={
                  canCancel
                    ? t("terminal.cancel")
                    : canDismiss
                      ? t("terminal.close")
                      : t("terminal.cancel")
                }
                disabled={!canCancel && !canDismiss}
                onClick={() => {
                  if (canCancel) setConfirmOpen(true);
                  else if (canDismiss) onDismiss?.();
                }}
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
                aria-label={
                  collapsed ? t("terminal.expand") : t("terminal.collapse")
                }
                onClick={() => setCollapsed((c) => !c)}
                style={DOT_HIT}
              >
                <span
                  aria-hidden
                  className="term-tl-face"
                  style={{ ...DOT_FACE, backgroundColor: DOT_MIN }}
                />
              </button>
              <button
                type="button"
                className="term-tl term-tl-max"
                title={t("terminal.openFullscreen")}
                aria-label={t("terminal.openFullscreen")}
                onClick={openFullscreen}
                style={DOT_HIT}
              >
                <span
                  aria-hidden
                  className="term-tl-face"
                  style={{ ...DOT_FACE, backgroundColor: DOT_MAX }}
                />
              </button>
            </div>
          ) : null}
          <div className="term-title">
            <span className="term-title-main">{title}</span>
            <span className="term-title-sub">
              {folderName || t("terminal.pendingFolder")}
            </span>
          </div>

          <label className="term-mode-switch" title={t("terminal.logMode")}>
            <span className={logMode === "simple" ? "on" : ""}>
              {upper(t("terminal.simple"))}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={logMode === "detail"}
              className={`term-switch${logMode === "detail" ? " term-switch-on" : ""}`}
              onClick={() => setLogMode((m) => (m === "simple" ? "detail" : "simple"))}
            >
              <span className="term-switch-knob" />
            </button>
            <span className={logMode === "detail" ? "on" : ""}>
              {upper(t("terminal.detail"))}
            </span>
          </label>

          <div className={`term-status term-status-${status}`}>
            {status === "running" ? <span className="term-pulse" /> : null}
            {statusLabel}
          </div>
        </div>

        {!collapsed ? (
          <>
            <div className="term-url" title={url}>
              {url}
            </div>
            <div
              className={`term-body${logMode === "simple" ? " term-body-simple" : ""}`}
              ref={scroller}
              onScroll={onScroll}
            >
              {displayLines.length === 0 ? (
                <div className="term-line" style={{ color: "#64748b" }}>
                  {logMode === "simple"
                    ? t("terminal.researchStarts")
                    : t("terminal.waiting")}
                </div>
              ) : null}
              {displayLines.map((line) => (
                <div
                  key={line.id}
                  className={`term-line term-kind-${line.kind}${
                    logMode === "simple" ? " term-line-simple" : ""
                  }`}
                  style={{ color: line.color }}
                >
                  <span className="term-stamp">{line.stamp}</span>
                  <span className="term-line-main">
                    {logMode === "detail"
                      ? renderDetailText(line.text, line.agent)
                      : line.text}
                  </span>
                  {logMode === "simple" && line.agentHint ? (
                    <span
                      className="term-agent-hint"
                      style={{
                        color: agentColor(line.agent),
                      }}
                    >
                      {" "}
                      ({line.agentHint})
                    </span>
                  ) : null}
                </div>
              ))}
              {status === "running" || status === "queued" ? (
                <div className="term-cursor-row">
                  <span className="term-cursor" />
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      {confirmOpen ? (
        <div
          className="term-modal-backdrop"
          role="presentation"
          onClick={() => setConfirmOpen(false)}
        >
          <div
            className="term-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`cancel-title-${jobId}`}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id={`cancel-title-${jobId}`}>{t("terminal.cancelTitle")}</h3>
            <p>{t("terminal.cancelBody")}</p>
            <div className="term-modal-actions">
              <button
                type="button"
                className="term-modal-btn term-modal-btn-ghost"
                onClick={() => setConfirmOpen(false)}
                disabled={cancelBusy}
              >
                {t("common.no")}
              </button>
              <button
                type="button"
                className="term-modal-btn term-modal-btn-danger"
                onClick={() => void confirmCancel()}
                disabled={cancelBusy}
              >
                {cancelBusy
                  ? t("terminal.canceling")
                  : t("terminal.confirmCancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
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

/** "Sentence. (Scout agent)" → body + hint */
function splitAgentParen(plain: string): { body: string; agentHint: string | null } {
  const m = plain.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!m) return { body: plain, agentHint: null };
  return { body: m[1].trim(), agentHint: m[2].trim() };
}

function agentColor(agent: string | null | undefined) {
  if (!agent) return "#94a3b8";
  return AGENT_COLOR[agent] || "#94a3b8";
}

function guessAgentFromText(text: string): string | null {
  const m = text.match(/^\[([a-z]+)\]/i);
  return m ? m[1].toLowerCase() : null;
}

/** Detail mode: color `[agent]` tag, keep kind color on the rest */
function renderDetailText(text: string, agent: string | null) {
  const m = text.match(/^\[([^\]]+)\](\s*)([\s\S]*)$/);
  if (!m) return text;
  const tag = m[1];
  const color = AGENT_COLOR[tag.toLowerCase()] || agentColor(agent);
  return (
    <>
      <span className="term-agent-tag" style={{ color }}>
        [{tag}]
      </span>
      {m[2]}
      {m[3]}
    </>
  );
}

/** Classic macOS traffic-light colors (header chrome only) */
const DOT_CLOSE = "#ff5f57";
const DOT_MIN = "#febc2e";
const DOT_MAX = "#28c840";

/** Hit target — transparent so button resets cannot steal the color */
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
  backgroundColor: "transparent",
  cursor: "pointer",
  flexShrink: 0,
  appearance: "none",
  WebkitAppearance: "none",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  lineHeight: 0,
};

/** Visible disc — color lives here, immune to `button { background }` resets */
const DOT_FACE: CSSProperties = {
  display: "block",
  width: 12,
  height: 12,
  borderRadius: "50%",
  border: "none",
  boxShadow: "none",
  flexShrink: 0,
};

function safeHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
