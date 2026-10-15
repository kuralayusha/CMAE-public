"use client";

import Link from "next/link";
import { useT } from "@/components/I18nProvider";
import type { AppPageId } from "@/lib/help/pages";

const LINKS: { href: string; id: AppPageId }[] = [
  { href: "/tracker", id: "tracker" },
  { href: "/search", id: "search" },
  { href: "/folders", id: "folders" },
  { href: "/settings", id: "settings" },
];

export function TopNav({
  active,
  onHelp,
  locked,
}: {
  active: AppPageId;
  onHelp?: () => void;
  /** Block all navigation (e.g. while language pack is building). */
  locked?: boolean;
}) {
  const t = useT();
  return (
    <nav
      className={`cmae-nav${locked ? " is-locked" : ""}`}
      aria-label={t("nav.aria")}
      aria-disabled={locked || undefined}
    >
      <div className="cmae-nav-inner">
        {locked ? (
          <span className="cmae-nav-brand">CMAE</span>
        ) : (
          <Link href="/tracker" className="cmae-nav-brand">
            CMAE
          </Link>
        )}
        <div className="cmae-nav-links">
          {LINKS.map((link) =>
            locked ? (
              <span
                key={link.id}
                className={`cmae-nav-link${active === link.id ? " is-active" : ""} is-disabled`}
                aria-disabled="true"
              >
                {t(`nav.${link.id}`)}
              </span>
            ) : (
              <Link
                key={link.id}
                href={link.href}
                className={`cmae-nav-link${active === link.id ? " is-active" : ""}`}
              >
                {t(`nav.${link.id}`)}
              </Link>
            ),
          )}
        </div>
        {onHelp && !locked ? (
          <button
            type="button"
            className="cmae-nav-help"
            onClick={onHelp}
            aria-label={t("nav.helpAria")}
            title={t("nav.helpTitle")}
          >
            ?
          </button>
        ) : null}
      </div>
    </nav>
  );
}
