"use client";

import { useEffect, useRef, useState } from "react";

export type SimLine = {
  kind: "think" | "curl" | "python" | "system" | "ok" | "err";
  agent?: string;
  text: string;
  delayMs: number;
};

const KIND_COLOR: Record<SimLine["kind"], string> = {
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

type Props = {
  url: string;
  title: string;
  folder: string;
  script: SimLine[];
  /** Stagger before this terminal starts typing */
  startDelayMs?: number;
  running: boolean;
  onDone?: () => void;
};

export function SimTerminal({
  url,
  title,
  folder,
  script,
  startDelayMs = 0,
  running,
  onDone,
}: Props) {
  const [lines, setLines] = useState<{ id: number; line: SimLine }[]>([]);
  const [status, setStatus] = useState<"queued" | "running" | "done">("queued");
  const [entered, setEntered] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!running) {
      setLines([]);
      setStatus("queued");
      setEntered(false);
      return;
    }

    const enterT = window.setTimeout(() => setEntered(true), startDelayMs);
    let cancelled = false;
    const timers: number[] = [];

    const kick = window.setTimeout(() => {
      if (cancelled) return;
      setStatus("running");
      let acc = 0;
      script.forEach((line, i) => {
        acc += line.delayMs;
        const t = window.setTimeout(() => {
          if (cancelled) return;
          setLines((prev) => [...prev, { id: i, line }]);
          if (i === script.length - 1) {
            setStatus("done");
            onDoneRef.current?.();
          }
        }, acc);
        timers.push(t);
      });
    }, startDelayMs + 180);

    timers.push(enterT, kick);
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [running, script, startDelayMs]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div
      className={`term-window cmae-land-sim-term${entered ? " is-in" : ""}`}
      data-status={status}
    >
      <div className="term-titlebar">
        <div className="term-tls" aria-hidden>
          <button type="button" className="term-tl term-tl-close" tabIndex={-1} disabled>
            <span className="term-tl-face" />
          </button>
          <button type="button" className="term-tl term-tl-min" tabIndex={-1} disabled>
            <span className="term-tl-face" />
          </button>
          <button type="button" className="term-tl term-tl-max" tabIndex={-1} disabled>
            <span className="term-tl-face" />
          </button>
        </div>
        <div className="term-title">
          <span className="term-title-main">{title}</span>
          <span className="term-title-sub">{folder}</span>
        </div>
        <div className={`term-status term-status-${status}`}>
          {status === "running" ? <span className="term-pulse" /> : null}
          {status === "queued"
            ? "QUEUED"
            : status === "running"
              ? "RUNNING"
              : "DONE"}
        </div>
      </div>
      <div className="term-url" title={url}>
        {url}
      </div>
      <div className="term-body term-body-simple" ref={scroller}>
        {lines.length === 0 ? (
          <div className="term-line" style={{ color: "#64748b" }}>
            Research starts…
          </div>
        ) : null}
        {lines.map(({ id, line }) => (
          <div
            key={id}
            className={`term-line term-kind-${line.kind} term-line-simple`}
            style={{ color: KIND_COLOR[line.kind] }}
          >
            <span className="term-stamp">
              {String(id + 1).padStart(2, "0")}
            </span>
            <span className="term-line-main">{line.text}</span>
            {line.agent ? (
              <span
                className="term-agent-hint"
                style={{ color: AGENT_COLOR[line.agent] || "#94a3b8" }}
              >
                {" "}
                ({line.agent})
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
    </div>
  );
}
