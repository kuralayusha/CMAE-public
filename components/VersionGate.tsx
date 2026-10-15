"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useI18n } from "@/components/I18nProvider";
import type { VersionStatus } from "@/lib/version/policy";
import "./version-gate.css";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FOCUS_MIN_GAP_MS = 60 * 60 * 1000;
const SOFT_DISMISS_KEY = "cmae.version.softDismissed";

type StatusPayload = VersionStatus & {
  error?: string;
};

function desktopPlatform(): { platform: string; arch: string } {
  if (typeof window === "undefined") {
    return { platform: "unknown", arch: "unknown" };
  }
  const d = window.cmaeDesktop;
  if (d?.platform && d?.arch) {
    return { platform: d.platform, arch: d.arch };
  }
  // Browser / web: no desktop lock
  return { platform: "web", arch: "web" };
}

function isDesktopRuntime(): boolean {
  return Boolean(
    typeof window !== "undefined" && window.cmaeDesktop?.isDesktop,
  );
}

async function fetchStatus(signal?: AbortSignal): Promise<StatusPayload> {
  const { platform, arch } = desktopPlatform();
  const qs = new URLSearchParams({ platform, arch });
  const res = await fetch(`/api/version?${qs}`, {
    cache: "no-store",
    signal,
  });
  const data = (await res.json().catch(() => ({}))) as StatusPayload & {
    status?: VersionStatus;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || `Version check failed (${res.status})`);
  }
  if (data.status) return { ...data.status };
  return data;
}

function softDismissedFor(latest: string): boolean {
  try {
    return sessionStorage.getItem(SOFT_DISMISS_KEY) === latest;
  } catch {
    return false;
  }
}

function setSoftDismissed(latest: string) {
  try {
    sessionStorage.setItem(SOFT_DISMISS_KEY, latest);
  } catch {
    /* ignore */
  }
}

export function VersionGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [updaterPhase, setUpdaterPhase] = useState<string | null>(null);
  const [softHidden, setSoftHidden] = useState(false);
  const lastCheckRef = useRef(0);
  const busyRef = useRef(false);

  const applyStatus = useEffectEvent((next: StatusPayload) => {
    setStatus(next);
    lastCheckRef.current = Date.now();
    if (next.softUpdate && softDismissedFor(next.latest)) {
      setSoftHidden(true);
    } else {
      setSoftHidden(false);
    }
  });

  const runCheck = useCallback(async (signal?: AbortSignal) => {
    if (!isDesktopRuntime()) return;
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const next = await fetchStatus(signal);
      applyStatus(next);
    } catch {
      // Network failure: do not lock. Keep previous status if any.
    } finally {
      busyRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) return;

    const ac = new AbortController();
    void runCheck(ac.signal);

    const interval = window.setInterval(() => {
      void runCheck();
    }, CHECK_INTERVAL_MS);

    const onFocus = () => {
      if (Date.now() - lastCheckRef.current < FOCUS_MIN_GAP_MS) return;
      void runCheck();
    };
    window.addEventListener("focus", onFocus);

    const unsub = window.cmaeDesktop?.onUpdateEvent?.((ev) => {
      setUpdaterPhase(ev.phase);
      if (ev.phase === "downloaded" || ev.phase === "available") {
        void runCheck();
      }
    });

    // Kick electron-updater quietly (packaged only)
    void window.cmaeDesktop?.checkForUpdates?.().catch(() => undefined);

    return () => {
      ac.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      unsub?.();
    };
  }, [runCheck]);

  useEffect(() => {
    if (!status?.forceLock) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const lockUrl = `${window.location.pathname}${window.location.search}`;
    window.history.pushState({ cmaeVersionLock: 1 }, "", lockUrl);
    const blockPop = () => {
      window.history.pushState({ cmaeVersionLock: 1 }, "", lockUrl);
    };
    window.addEventListener("popstate", blockPop);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("popstate", blockPop);
    };
  }, [status?.forceLock]);

  async function openDownload() {
    const url = status?.downloadUrl || status?.releaseUrl;
    if (!url) return;
    if (window.cmaeDesktop?.openExternal) {
      await window.cmaeDesktop.openExternal(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function installNow() {
    if (window.cmaeDesktop?.quitAndInstall) {
      await window.cmaeDesktop.quitAndInstall();
      return;
    }
    await openDownload();
  }

  const showForce = Boolean(status?.forceLock);
  const showSoft =
    Boolean(status?.softUpdate) && !showForce && !softHidden && isDesktopRuntime();

  return (
    <>
      {showSoft && status ? (
        <div className="cmae-version-banner" role="status">
          <p>
            {t("versionGate.softLead", {
              current: status.current,
              latest: status.latest,
            })}
            {updaterPhase === "downloading"
              ? ` ${t("versionGate.downloading")}`
              : null}
            {updaterPhase === "downloaded" ? ` ${t("versionGate.ready")}` : null}
          </p>
          <div className="cmae-version-banner-actions">
            {updaterPhase === "downloaded" ? (
              <button
                type="button"
                className="is-primary"
                onClick={() => void installNow()}
              >
                {t("versionGate.installNow")}
              </button>
            ) : (
              <button
                type="button"
                className="is-primary"
                onClick={() => void openDownload()}
              >
                {t("versionGate.download")}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setSoftDismissed(status.latest);
                setSoftHidden(true);
              }}
            >
              {t("versionGate.dismiss")}
            </button>
          </div>
        </div>
      ) : null}

      <div inert={showForce ? true : undefined}>{children}</div>

      {showForce && status ? (
        <div
          className="cmae-version-lock"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="cmae-version-lock-title"
        >
          <div className="cmae-version-lock-inner">
            <div className="cmae-version-lock-brand">
              {t("versionGate.brand")}
            </div>
            <h1 id="cmae-version-lock-title">{t("versionGate.title")}</h1>
            <p>
              {t("versionGate.lead", {
                current: status.current,
                latest: status.latest,
              })}
            </p>
            <p className="cmae-version-lock-meta">
              {status.current} → {status.latest}
            </p>
            {status.notes ? (
              <>
                <p className="cmae-version-lock-meta">
                  {t("versionGate.notes")}
                </p>
                <pre className="cmae-version-lock-notes">{status.notes}</pre>
              </>
            ) : null}
            {updaterPhase === "downloading" ? (
              <p>{t("versionGate.downloading")}</p>
            ) : null}
            {updaterPhase === "downloaded" ? (
              <p>{t("versionGate.ready")}</p>
            ) : null}
            <div className="cmae-version-lock-actions">
              {updaterPhase === "downloaded" ? (
                <button
                  type="button"
                  className="cmae-version-lock-btn"
                  onClick={() => void installNow()}
                >
                  {t("versionGate.installNow")}
                </button>
              ) : (
                <button
                  type="button"
                  className="cmae-version-lock-btn"
                  onClick={() => void openDownload()}
                >
                  {t("versionGate.download")}
                </button>
              )}
              <button
                type="button"
                className="cmae-version-lock-btn is-secondary"
                onClick={() => void openDownload()}
              >
                {t("versionGate.openRelease")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
