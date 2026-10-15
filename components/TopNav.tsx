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
}: {
  active: AppPageId;
  onHelp?: () => void;
}) {
  const t = useT();
  return (
    <nav className="cmae-nav" aria-label={t("nav.aria")}>
      <div className="cmae-nav-inner">
        <Link href="/tracker" className="cmae-nav-brand">
          CMAE
        </Link>
        <div className="cmae-nav-links">
          {LINKS.map((link) => (
            <Link
              key={link.id}
              href={link.href}
              className={`cmae-nav-link${active === link.id ? " is-active" : ""}`}
            >
              {t(`nav.${link.id}`)}
            </Link>
          ))}
        </div>
        {onHelp ? (
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
