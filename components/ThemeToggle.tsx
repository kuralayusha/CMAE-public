"use client";

import { useEffect, useState } from "react";
import { HoverTip } from "@/components/HoverTip";
import { useT } from "@/components/I18nProvider";
import {
  cycleThemePreference,
  getThemePreference,
  subscribeSystemTheme,
  type ThemePreference,
} from "@/lib/theme";

function SunIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm-9 4h2v2H3v-2zm16 0h2v2h-2v-2zM11 3h2v2h-2V3zm0 16h2v2h-2v-2zM5.99 4.58l1.41 1.41-1.41 1.42-1.42-1.42 1.42-1.41zm12.37 12.37 1.41 1.41-1.41 1.42-1.42-1.42 1.42-1.41zM18.36 5.99l1.42 1.42-1.42 1.41-1.41-1.41 1.41-1.42zM5.99 18.36l1.41-1.41 1.42 1.41-1.42 1.42-1.41-1.42z"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"
      />
    </svg>
  );
}

/** Half-sun (toggles.dev) — system / auto theme. */
function SystemIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
      <path
        fill="currentColor"
        d="M27.5 11.5v-7h-7L16 0l-4.5 4.5h-7v7L0 16l4.5 4.5v7h7L16 32l4.5-4.5h7v-7L32 16l-4.5-4.5zM16 25.4V6.6c5.2 0 9.4 4.2 9.4 9.4s-4.2 9.4-9.4 9.4z"
      />
    </svg>
  );
}

export function ThemeToggle({ disabled }: { disabled?: boolean }) {
  const t = useT();
  const [preference, setPreference] = useState<ThemePreference>("system");

  useEffect(() => {
    setPreference(getThemePreference());
    return subscribeSystemTheme(() => {
      /* preference stays system; DOM already updated */
    });
  }, []);

  const modeLabel =
    preference === "light"
      ? t("nav.themeModeLight")
      : preference === "dark"
        ? t("nav.themeModeDark")
        : t("nav.themeModeSystem");

  const icon =
    preference === "light" ? (
      <SunIcon />
    ) : preference === "dark" ? (
      <MoonIcon />
    ) : (
      <SystemIcon />
    );

  return (
    <HoverTip label={modeLabel}>
      <button
        type="button"
        className="cmae-btn cmae-btn-ghost cmae-theme-toggle"
        aria-label={modeLabel}
        disabled={disabled}
        onClick={() => {
          setPreference(cycleThemePreference());
        }}
      >
        {icon}
      </button>
    </HoverTip>
  );
}
