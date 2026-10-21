"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useT } from "@/components/I18nProvider";
import { TrackerDetail } from "@/components/TrackerDetail";
import "./tracker-detail.css";

const EASE_IN = "cubic-bezier(0.16, 1, 0.3, 1)";
const EASE_OUT = "cubic-bezier(0.4, 0, 0.2, 1)";
const DUR_IN_MS = 520;
const DUR_OUT_MS = 460;
const DUR_BACKDROP_IN_MS = 480;
const DUR_BACKDROP_OUT_MS = 400;

export type TrackerHistoryDrawerHandle = {
  open: (itemId: number) => void;
  close: () => void;
  isOpen: () => boolean;
};

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function cancelAnim(anim: Animation | null | undefined) {
  try {
    anim?.cancel();
  } catch {
    /* already finished */
  }
}

/** Hold the on-screen transform/opacity, then cancel WAAPI so it doesn't snap. */
function holdThenCancel(
  el: HTMLElement,
  anim: Animation | null | undefined,
  prop: "transform" | "opacity",
) {
  const computed = getComputedStyle(el);
  const value =
    prop === "transform" ? computed.transform : computed.opacity;
  cancelAnim(anim);
  if (prop === "transform") {
    el.style.transform =
      value && value !== "none" ? value : "translateX(100%)";
  } else {
    el.style.opacity = value || "0";
  }
}

/**
 * Always-mounted history drawer. Open/close drive WAAPI on the click path
 * so the slide starts in the same event turn — no React-commit wait.
 */
export const TrackerHistoryDrawer = forwardRef<TrackerHistoryDrawerHandle>(
  function TrackerHistoryDrawer(_props, ref) {
    const t = useT();
    const [itemId, setItemId] = useState<number | null>(null);
    const [contentId, setContentId] = useState<number | null>(null);

    const rootRef = useRef<HTMLDivElement>(null);
    const backdropRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLElement>(null);
    const drawerAnimRef = useRef<Animation | null>(null);
    const backdropAnimRef = useRef<Animation | null>(null);
    const openRef = useRef(false);
    const closingRef = useRef(false);
    const contentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearContentTimer = useCallback(() => {
      if (contentTimerRef.current != null) {
        clearTimeout(contentTimerRef.current);
        contentTimerRef.current = null;
      }
    }, []);

    const lockScroll = useCallback((lock: boolean) => {
      if (lock) {
        document.body.dataset.cmaeHistoryDrawer = "1";
        document.body.style.overflow = "hidden";
      } else if (document.body.dataset.cmaeHistoryDrawer === "1") {
        delete document.body.dataset.cmaeHistoryDrawer;
        document.body.style.overflow = "";
      }
    }, []);

    const close = useCallback(() => {
      if (!openRef.current || closingRef.current) return;
      closingRef.current = true;
      clearContentTimer();

      const panel = panelRef.current;
      const backdrop = backdropRef.current;
      const root = rootRef.current;

      if (!panel || !backdrop) {
        openRef.current = false;
        closingRef.current = false;
        root?.classList.remove("is-active");
        root?.setAttribute("aria-hidden", "true");
        lockScroll(false);
        setItemId(null);
        setContentId(null);
        return;
      }

      holdThenCancel(panel, drawerAnimRef.current, "transform");
      holdThenCancel(backdrop, backdropAnimRef.current, "opacity");

      const finish = () => {
        openRef.current = false;
        closingRef.current = false;
        if (root) {
          root.classList.remove("is-active");
          root.setAttribute("aria-hidden", "true");
        }
        panel.style.transform = "";
        backdrop.style.opacity = "";
        lockScroll(false);
        setItemId(null);
        setContentId(null);
      };

      const reduced = prefersReducedMotion();
      const dur = reduced ? 1 : DUR_OUT_MS;
      const durBg = reduced ? 1 : DUR_BACKDROP_OUT_MS;
      const fromTransform = panel.style.transform || "translateX(0)";
      const fromOpacity = Number(backdrop.style.opacity) || 1;

      backdropAnimRef.current = backdrop.animate(
        [{ opacity: fromOpacity }, { opacity: 0 }],
        { duration: durBg, easing: "ease", fill: "forwards" },
      );
      const anim = panel.animate(
        [
          { transform: fromTransform },
          { transform: "translateX(100%)" },
        ],
        { duration: dur, easing: EASE_OUT, fill: "forwards" },
      );
      drawerAnimRef.current = anim;
      anim.onfinish = finish;
      anim.oncancel = () => {
        /* superseded by a new open/close */
      };
    }, [clearContentTimer, lockScroll]);

    const open = useCallback(
      (nextId: number) => {
        const panel = panelRef.current;
        const backdrop = backdropRef.current;
        const root = rootRef.current;
        if (!panel || !backdrop || !root) return;

        const wasClosing = closingRef.current;
        const alreadyOpen = openRef.current && !wasClosing;

        closingRef.current = false;
        clearContentTimer();

        // DOM first — same click turn, before React paint
        root.classList.add("is-active");
        root.setAttribute("aria-hidden", "false");
        lockScroll(true);
        openRef.current = true;

        setItemId(nextId);

        if (!alreadyOpen) {
          const reduced = prefersReducedMotion();
          const dur = reduced ? 1 : DUR_IN_MS;
          const durBg = reduced ? 1 : DUR_BACKDROP_IN_MS;

          holdThenCancel(panel, drawerAnimRef.current, "transform");
          holdThenCancel(backdrop, backdropAnimRef.current, "opacity");

          const fromTransform = wasClosing
            ? panel.style.transform || "translateX(100%)"
            : "translateX(100%)";
          const fromOpacity = wasClosing
            ? Number(backdrop.style.opacity) || 0
            : 0;

          if (!wasClosing) {
            panel.style.transform = "translateX(100%)";
            backdrop.style.opacity = "0";
          }

          backdropAnimRef.current = backdrop.animate(
            [{ opacity: fromOpacity }, { opacity: 1 }],
            { duration: durBg, easing: "ease", fill: "forwards" },
          );
          const anim = panel.animate(
            [
              { transform: fromTransform },
              { transform: "translateX(0)" },
            ],
            { duration: dur, easing: EASE_IN, fill: "forwards" },
          );
          drawerAnimRef.current = anim;
          anim.onfinish = () => {
            // Keep final pose via fill:forwards; clear only holds from interrupt
            if (panel.style.transform) panel.style.transform = "translateX(0)";
            if (backdrop.style.opacity) backdrop.style.opacity = "1";
          };
        }
        // alreadyOpen: leave current open pose / WAAPI fill as-is

        // Heavy detail after the first animation frames are queued
        contentTimerRef.current = setTimeout(() => {
          contentTimerRef.current = null;
          setContentId(nextId);
        }, alreadyOpen ? 0 : 32);
      },
      [clearContentTimer, lockScroll],
    );

    useImperativeHandle(
      ref,
      () => ({
        open,
        close,
        isOpen: () => openRef.current && !closingRef.current,
      }),
      [open, close],
    );

    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        if (!openRef.current || closingRef.current) return;
        e.stopPropagation();
        close();
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [close]);

    useEffect(() => {
      return () => {
        clearContentTimer();
        cancelAnim(drawerAnimRef.current);
        cancelAnim(backdropAnimRef.current);
        lockScroll(false);
      };
    }, [clearContentTimer, lockScroll]);

    return (
      <div
        ref={rootRef}
        className="cmae-td-drawer-root"
        role="presentation"
        aria-hidden="true"
      >
        <div
          ref={backdropRef}
          className="cmae-td-drawer-backdrop"
          onClick={close}
          aria-hidden
        />
        <aside
          ref={panelRef}
          className="cmae-td-drawer"
          role="dialog"
          aria-modal="true"
          aria-label={t("tracker.detailPage.timeline")}
          onClick={(e) => e.stopPropagation()}
        >
          <header className="cmae-td-drawer-head">
            <button
              type="button"
              className="cmae-td-close"
              onClick={close}
              aria-label={t("common.close")}
            >
              ×
            </button>
          </header>
          <div className="cmae-td-drawer-scroll">
            {contentId != null ? (
              <TrackerDetail
                key={contentId}
                itemId={contentId}
                variant="panel"
                onClose={close}
                onOpenItem={open}
              />
            ) : itemId != null ? (
              <p className="cmae-td-muted">{t("tracker.detailPage.loading")}</p>
            ) : null}
          </div>
        </aside>
      </div>
    );
  },
);
