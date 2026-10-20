"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/** Almost stuck to the trigger. */
const GAP = 2;
const EDGE = 8;
/** Native `title` tooltips usually appear ~1s; use half of that for hover. */
const SHOW_DELAY_MS = 500;

/**
 * Always-on hover tooltip (same visual language as TruncateTip).
 * Prefer this over native `title` for action buttons.
 * Anchored bottom-left of the trigger (does not follow the cursor).
 * Flips to the right when there is not enough room on the left.
 */
export function HoverTip({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  /** Extra class on the trigger wrap (e.g. full-width cells). */
  className?: string;
}) {
  const tipId = useId();
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const delayRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0, ready: false });
  const text = String(label || "").trim();

  function clearDelay() {
    if (delayRef.current != null) {
      window.clearTimeout(delayRef.current);
      delayRef.current = null;
    }
  }

  useEffect(() => () => clearDelay(), []);

  useLayoutEffect(() => {
    if (!open || !text) return;
    const tip = tipRef.current;
    const wrap = wrapRef.current;
    if (!tip || !wrap) return;

    const r = wrap.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;

    // Default: tip hangs to the left of the trigger, just below it.
    let x = r.left - tw;
    let y = r.bottom + GAP;

    // Not enough room on the left → open to the right of the trigger.
    if (x < EDGE) {
      x = r.right;
    }

    if (x + tw > window.innerWidth - EDGE) {
      x = window.innerWidth - EDGE - tw;
    }
    if (x < EDGE) x = EDGE;

    if (y + th > window.innerHeight - EDGE) {
      y = Math.max(EDGE, r.top - GAP - th);
    }

    setPos((prev) =>
      prev.x === x && prev.y === y && prev.ready
        ? prev
        : { x, y, ready: true },
    );
  }, [open, text]);

  if (!text) return <>{children}</>;

  function showNow() {
    clearDelay();
    setPos((prev) => ({ ...prev, ready: false }));
    setOpen(true);
  }

  function showDelayed() {
    clearDelay();
    delayRef.current = window.setTimeout(showNow, SHOW_DELAY_MS);
  }

  function hide() {
    clearDelay();
    setOpen(false);
    setPos((prev) => ({ ...prev, ready: false }));
  }

  return (
    <>
      <span
        ref={wrapRef}
        className={`cmae-hover-tip-wrap${className ? ` ${className}` : ""}`}
        onMouseEnter={showDelayed}
        onMouseLeave={hide}
        onFocus={showNow}
        onBlur={hide}
      >
        {children}
      </span>
      {open
        ? createPortal(
            <div
              ref={tipRef}
              id={tipId}
              role="tooltip"
              className="cmae-truncate-tip cmae-hover-tip"
              style={{
                left: pos.x,
                top: pos.y,
                visibility: pos.ready ? "visible" : "hidden",
              }}
            >
              {text}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
