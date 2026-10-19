export const THEME_KEY = "cmae.theme";

/** Persisted choice. `system` = follow OS (default when unset). */
export type ThemePreference = "light" | "dark" | "system";

/** Resolved appearance applied to the document. */
export type Theme = "light" | "dark";

const CYCLE: ThemePreference[] = ["light", "dark", "system"];

export function getSystemTheme(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  } catch {
    return "light";
  }
}

export function getThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    /* private mode */
  }
  return "system";
}

export function getResolvedTheme(
  preference: ThemePreference = getThemePreference(),
): Theme {
  return preference === "system" ? getSystemTheme() : preference;
}

export function applyResolvedTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

export function setThemePreference(preference: ThemePreference): Theme {
  try {
    localStorage.setItem(THEME_KEY, preference);
  } catch {
    /* private mode / quota */
  }
  const resolved = getResolvedTheme(preference);
  applyResolvedTheme(resolved);
  return resolved;
}

/** Cycle light → dark → system → light. */
export function cycleThemePreference(): ThemePreference {
  const current = getThemePreference();
  const next = CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length]!;
  setThemePreference(next);
  return next;
}

/** Re-apply when OS theme changes while preference is `system`. */
export function subscribeSystemTheme(
  onChange: (theme: Theme) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  let mql: MediaQueryList;
  try {
    mql = window.matchMedia("(prefers-color-scheme: dark)");
  } catch {
    return () => {};
  }
  const handler = () => {
    if (getThemePreference() !== "system") return;
    const theme = getSystemTheme();
    applyResolvedTheme(theme);
    onChange(theme);
  };
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
}
