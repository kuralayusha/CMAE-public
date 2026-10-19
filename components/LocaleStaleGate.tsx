"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/components/I18nProvider";
import { LocalePrepOverlay } from "@/components/LocalePrepOverlay";
import { APP_LANGUAGE } from "@/lib/i18n/types";

/**
 * When shipped en.json gains new keys, an older user pack mixes EN+TR.
 * Settings already refreshes on load; this runs app-wide (Tracker, Folders, …).
 */
export function LocaleStaleGate({ children }: { children: ReactNode }) {
  const { code, setPack, reload } = useI18n();
  const [target, setTarget] = useState<string | null>(null);
  const checkedRef = useRef<string | false>(false);

  useEffect(() => {
    const lang = (code || APP_LANGUAGE).toLowerCase();
    if (!lang || lang === APP_LANGUAGE || lang.startsWith("en")) return;
    // Re-check when language code changes; also once per mount.
    if (checkedRef.current === code) return;
    checkedRef.current = code;

    void (async () => {
      try {
        const res = await fetch("/api/i18n/pack", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { needsTranslation?: boolean };
        if (data.needsTranslation) setTarget(code);
      } catch {
        /* ignore */
      }
    })();
  }, [code]);

  if (target) {
    return (
      <LocalePrepOverlay
        targetLanguage={target}
        mode="overlay"
        doneKey="settings.localePrepDone"
        failKey="settings.localePrepFail"
        onComplete={(result) => {
          if (!result.deferred) {
            setPack(result.code, result.pack);
          }
          setTarget(null);
          void reload();
        }}
        onError={() => {
          setTarget(null);
        }}
      />
    );
  }

  return <>{children}</>;
}
