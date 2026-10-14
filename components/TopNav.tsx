import Link from "next/link";
import { PAGE_HELP, type AppPageId } from "@/lib/help/pages";

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
  return (
    <nav className="cmae-nav" aria-label="Ana navigasyon">
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
              {PAGE_HELP[link.id].navLabel}
            </Link>
          ))}
        </div>
        {onHelp ? (
          <button
            type="button"
            className="cmae-nav-help"
            onClick={onHelp}
            aria-label="About this page"
            title="About this page"
          >
            ?
          </button>
        ) : null}
      </div>
    </nav>
  );
}
