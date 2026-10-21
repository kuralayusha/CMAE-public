"use client";

import { useEffect, useState } from "react";

type Props = {
  /** ISO timestamp or date string passed to the formatter. */
  value: string | null | undefined;
  locale: string;
  format: (value: string, locale: string) => string;
  /** Stable SSR/hydration placeholder (defaults to the raw value or em dash). */
  fallback?: string;
  className?: string;
};

/**
 * Locale date/time strings often differ between Node SSR and the browser.
 * Render a stable placeholder until mount, then format on the client.
 */
export function ClientFormattedTime({
  value,
  locale,
  format,
  fallback,
  className,
}: Props) {
  const placeholder = fallback ?? (value && value.trim() ? value : "—");
  const [text, setText] = useState(placeholder);

  useEffect(() => {
    if (!value) {
      setText(fallback ?? "—");
      return;
    }
    try {
      setText(format(value, locale));
    } catch {
      setText(placeholder);
    }
  }, [value, locale, format, fallback, placeholder]);

  return (
    <span className={className} suppressHydrationWarning>
      {text}
    </span>
  );
}
