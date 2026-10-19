"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Always-on hover tooltip (same visual language as TruncateTip).
 * Prefer this over native `title` for action buttons.
 */
export function HoverTip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const tipId = useId();
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const text = String(label || "").trim();
  if (!text) return <>{children}</>;

  function show() {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(r.left, window.innerWidth - 280),
      y: r.bottom + 6,
    });
    setOpen(true);
  }

  return (
    <>
      <span
        ref={wrapRef}
        className="cmae-hover-tip-wrap"
        onMouseEnter={show}
        onMouseLeave={() => setOpen(false)}
        onFocus={show}
        onBlur={() => setOpen(false)}
      >
        {children}
      </span>
      {open
        ? createPortal(
            <div
              id={tipId}
              role="tooltip"
              className="cmae-truncate-tip"
              style={{ left: pos.x, top: pos.y }}
            >
              {text}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
