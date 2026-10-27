"use client";

import { useEffect, useState } from "react";

/**
 * Client gate for (app) routes. Uses the same /api/onboarding/* SQLite path as
 * Start system — RSC layout redirects were reading a different DB file and
 * bounced users back to onboarding after a successful complete.
 */
export function RequireOnboarded({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await fetch("/api/onboarding/reconcile", {
          method: "POST",
          cache: "no-store",
        }).catch(() => null);
        const res = await fetch("/api/onboarding/status", {
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (data.complete || data.flagSet) {
          // Upgraded from the Cursor era: onboarded, but no OpenRouter key yet.
          // Send them to Settings (AI section opens) instead of failing on the
          // first model call.
          const needsAiKey =
            Array.isArray(data.gaps) && data.gaps.includes("openrouterApiKey");
          if (needsAiKey && window.location.pathname !== "/settings") {
            window.location.replace("/settings");
            return;
          }
          setReady(true);
          return;
        }
      } catch {
        /* fall through */
      }
      if (!cancelled) {
        window.location.replace("/onboarding");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          fontFamily: "system-ui, sans-serif",
          color: "#666",
          fontSize: 14,
        }}
      >
        …
      </div>
    );
  }

  return children;
}
