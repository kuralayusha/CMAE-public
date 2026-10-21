"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type TransitionEvent,
} from "react";
import { BrandMark } from "@/components/BrandMark";
import { useT } from "@/components/I18nProvider";
import { ThemeToggle } from "@/components/ThemeToggle";
import type { AppPageId } from "@/lib/help/pages";

const LINKS: { href: string; id: AppPageId | "usage" }[] = [
  { href: "/tracker", id: "tracker" },
  { href: "/research", id: "research" },
  { href: "/folders", id: "folders" },
  { href: "/usage", id: "usage" },
  { href: "/settings", id: "settings" },
];

/** Must match `.cmae-nav-indicator.is-ready` height duration (+ buffer). */
const HEIGHT_MS = 140;

type Indicator = { left: number; width: number };
type Phase = "idle" | "collapsing" | "sliding";

/** Survives layout remounts so the underline can animate from the previous tab. */
let lastIndicator: Indicator | null = null;

function activeFromPath(pathname: string | null): AppPageId | "usage" {
  if (!pathname) return "tracker";
  if (pathname.startsWith("/research")) return "research";
  if (pathname.startsWith("/folders")) return "folders";
  if (pathname.startsWith("/usage")) return "usage";
  if (pathname.startsWith("/settings")) return "settings";
  return "tracker";
}

function sameBox(a: Indicator, b: Indicator) {
  return a.left === b.left && a.width === b.width;
}

/** Full link box — fills behind the label after the slide settles. */
function readActiveBox(root: HTMLElement): Indicator | null {
  const el = root.querySelector<HTMLElement>(".cmae-nav-link.is-active");
  if (!el) return null;
  return { left: el.offsetLeft, width: el.offsetWidth };
}

export function TopNav({
  locked,
}: {
  /** Block all navigation (e.g. while language pack is building). */
  locked?: boolean;
} = {}) {
  const t = useT();
  const pathname = usePathname();
  const active = activeFromPath(pathname);
  const brand = <BrandMark size={32} className="cmae-nav-brand-mark" />;
  const linksRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const [indicator, setIndicator] = useState<Indicator | null>(
    () => lastIndicator,
  );
  const [ready, setReady] = useState(() => Boolean(lastIndicator));
  const [filled, setFilled] = useState(false);
  const filledRef = useRef(false);
  const phaseRef = useRef<Phase>("idle");
  const pendingRef = useRef<Indicator | null>(null);
  const slideGen = useRef(0);

  useEffect(() => {
    filledRef.current = filled;
  }, [filled]);

  useEffect(() => {
    const root = linksRef.current;
    if (!root) return;

    let raf = 0;
    let collapseTimer = 0;
    const gen = ++slideGen.current;
    const next = readActiveBox(root);

    function beginSlide(target: Indicator) {
      pendingRef.current = null;
      phaseRef.current = "sliding";
      lastIndicator = target;
      setIndicator(target);
    }

    function afterCollapse(target: Indicator) {
      if (slideGen.current !== gen) return;
      if (phaseRef.current !== "collapsing") return;
      beginSlide(target);
    }

    if (next) {
      setReady(true);

      if (!lastIndicator) {
        lastIndicator = next;
        setIndicator(next);
        raf = requestAnimationFrame(() => {
          if (slideGen.current !== gen) return;
          filledRef.current = true;
          setFilled(true);
        });
      } else if (sameBox(lastIndicator, next) && phaseRef.current === "idle") {
        filledRef.current = true;
        setFilled(true);
      } else {
        // Collapse plate fully before sliding horizontally
        pendingRef.current = next;
        if (filledRef.current) {
          phaseRef.current = "collapsing";
          filledRef.current = false;
          setFilled(false);
          collapseTimer = window.setTimeout(
            () => afterCollapse(next),
            HEIGHT_MS + 20,
          );
        } else {
          beginSlide(next);
        }
      }
    }

    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            if (phaseRef.current !== "idle") return;
            const box = readActiveBox(root);
            if (!box) return;
            lastIndicator = box;
            setIndicator(box);
            setReady(true);
          })
        : null;
    ro?.observe(root);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(collapseTimer);
      ro?.disconnect();
    };
  }, [active, t]);

  function onIndicatorTransitionEnd(e: TransitionEvent<HTMLSpanElement>) {
    if (e.target !== indicatorRef.current) return;

    // Plate fully shrunk → start the horizontal slide
    if (phaseRef.current === "collapsing" && e.propertyName === "height") {
      const target = pendingRef.current;
      if (!target) return;
      pendingRef.current = null;
      phaseRef.current = "sliding";
      lastIndicator = target;
      setIndicator(target);
      return;
    }

    // Slide finished → grow plate back up
    if (
      phaseRef.current === "sliding" &&
      (e.propertyName === "transform" || e.propertyName === "width")
    ) {
      phaseRef.current = "idle";
      filledRef.current = true;
      setFilled(true);
    }
  }

  return (
    <nav
      className={`cmae-nav${locked ? " is-locked" : ""}`}
      aria-label={t("nav.aria")}
      aria-disabled={locked || undefined}
    >
      <div className="cmae-nav-inner">
        {locked ? (
          <span className="cmae-nav-brand" aria-label="CMAE">
            {brand}
          </span>
        ) : (
          <Link
            href="/tracker"
            className="cmae-nav-brand"
            aria-label="CMAE"
            title="CMAE"
          >
            {brand}
          </Link>
        )}
        <div
          className={`cmae-nav-links${filled ? " is-filled" : ""}`}
          ref={linksRef}
        >
          {indicator ? (
            <span
              ref={indicatorRef}
              className={`cmae-nav-indicator${ready ? " is-ready" : ""}${filled ? " is-filled" : ""}`}
              style={{
                transform: `translate3d(${indicator.left}px, 0, 0)`,
                width: indicator.width,
              }}
              aria-hidden="true"
              onTransitionEnd={onIndicatorTransitionEnd}
            />
          ) : null}
          {LINKS.map((link) => {
            const isActive = active === link.id;
            const className = `cmae-nav-link${isActive ? " is-active" : ""}${locked ? " is-disabled" : ""}`;
            if (locked) {
              return (
                <span
                  key={link.id}
                  className={className}
                  aria-disabled="true"
                >
                  {t(`nav.${link.id}`)}
                </span>
              );
            }
            return (
              <Link
                key={link.id}
                href={link.href}
                className={className}
                aria-current={isActive ? "page" : undefined}
              >
                {t(`nav.${link.id}`)}
              </Link>
            );
          })}
        </div>
        <div className="cmae-nav-actions">
          <ThemeToggle disabled={locked} />
        </div>
      </div>
    </nav>
  );
}
