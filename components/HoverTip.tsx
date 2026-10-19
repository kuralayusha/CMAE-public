"use client";

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const GAP = 8;
const EDGE = 8;
/** Tip's right edge sits this many px left of the pointer. */
const CURSOR_GAP = 4;

/**
 * Always-on hover tooltip (same visual language as TruncateTip).
 * Prefer this over native `title` for action buttons.
 * Anchored bottom-left of the cursor: tip hangs to the left, just below.
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
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [pos, setPos] = useState({ x: 0, y: 0, ready: false });
  const text = String(label || "").trim();

  useLayoutEffect(() => {
    if (!open || !text) return;
    const tip = tipRef.current;
    if (!tip) return;

    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;

    // Right edge of tip near cursor → tip sits bottom-left of the pointer.
    let x = cursor.x - tw - CURSOR_GAP;
    let y = cursor.y + GAP;

    if (x < EDGE) x = EDGE;
    if (x + tw > window.innerWidth - EDGE) {
      x = window.innerWidth - EDGE - tw;
    }
    if (y + th > window.innerHeight - EDGE) {
      y = Math.max(EDGE, cursor.y - GAP - th);
    }

    setPos((prev) =>
      prev.x === x && prev.y === y && prev.ready
        ? prev
        : { x, y, ready: true },
    );
  }, [open, cursor.x, cursor.y, text]);

  if (!text) return <>{children}</>;

  function placeNearCursor(clientX: number, clientY: number) {
    setCursor({ x: clientX, y: clientY });
  }

  function showFromMouse(e: MouseEvent) {
    placeNearCursor(e.clientX, e.clientY);
    setPos((prev) => ({ ...prev, ready: false }));
    setOpen(true);
  }

  function showFromFocus() {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    placeNearCursor(r.left + r.width / 2, r.bottom);
    setPos((prev) => ({ ...prev, ready: false }));
    setOpen(true);
  }

  return (
    <>
      <span
        ref={wrapRef}
        className="cmae-hover-tip-wrap"
        onMouseEnter={showFromMouse}
        onMouseMove={(e) => {
          if (!open) return;
          placeNearCursor(e.clientX, e.clientY);
        }}
        onMouseLeave={() => {
          setOpen(false);
          setPos((prev) => ({ ...prev, ready: false }));
        }}
        onFocus={showFromFocus}
        onBlur={() => {
          setOpen(false);
          setPos((prev) => ({ ...prev, ready: false }));
        }}
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
