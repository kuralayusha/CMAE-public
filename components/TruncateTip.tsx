"use client";

import { useCallback, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Collapse newlines / multi-space so table cells never break visually. */
function flatText(text: string): string {
  return String(text ?? "")
    .replace(/[\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Single-line ellipsis cell. Custom tooltip only when text is actually truncated.
 */
export function TruncateTip({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const display = flatText(text);
  const ref = useRef<HTMLSpanElement | null>(null);
  const tipId = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const isTruncated = useCallback(() => {
    const el = ref.current;
    if (!el) return false;
    return el.scrollWidth > el.clientWidth + 1;
  }, []);

  function show() {
    const el = ref.current;
    if (!el || !isTruncated()) {
      setOpen(false);
      return;
    }
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
        ref={ref}
        className={`cmae-truncate${className ? ` ${className}` : ""}`}
        onMouseEnter={show}
        onMouseLeave={() => setOpen(false)}
        onFocus={show}
        onBlur={() => setOpen(false)}
        tabIndex={-1}
        aria-describedby={open ? tipId : undefined}
      >
        {display}
      </span>
      {open
        ? createPortal(
            <div
              id={tipId}
              role="tooltip"
              className="cmae-truncate-tip"
              style={{ left: pos.x, top: pos.y }}
            >
              {display}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
