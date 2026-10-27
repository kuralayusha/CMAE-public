"use client";

import type { ReactNode } from "react";
import { useT } from "@/components/I18nProvider";
import { ExternalLinkIcon } from "@/components/icons";

/**
 * Link that leaves the app (new tab). The icon sits inside the anchor and the
 * underline is a border, so text and icon read as one underlined link.
 */
export function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <a
      className="cmae-ext-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
      <ExternalLinkIcon size={12} className="cmae-ext-link-icon" />
      <span className="cmae-sr-only"> ({t("common.opensInNewTab")})</span>
    </a>
  );
}
