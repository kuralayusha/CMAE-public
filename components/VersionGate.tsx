"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { BrandMark } from "@/components/BrandMark";
import { useI18n } from "@/components/I18nProvider";
import { DEFAULT_I18N_REMOTE_BASE } from "@/lib/i18n/remote";
import type { VersionStatus } from "@/lib/version/policy";
import {
  formatVersionLabel,
  formatVersionTag,
} from "@/lib/version/semver";
import "./version-gate.css";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FOCUS_MIN_GAP_MS = 60 * 60 * 1000;
const LANDING_URL = DEFAULT_I18N_REMOTE_BASE;

type StatusPayload = VersionStatus & {
  error?: string;
};

type UpdaterPhase =
  | "checking"
  | "available"
  | "none"
  | "downloading"
  | "downloaded"
  | "error"
  | string;

function desktopPlatform(): { platform: string; arch: string } {
  if (typeof window === "undefined") {
    return { platform: "unknown", arch: "unknown" };
  }
  const d = window.cmaeDesktop;
  if (d?.platform && d?.arch) {
    return { platform: d.platform, arch: d.arch };
  }
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

function isBusyPhase(phase: UpdaterPhase | null): boolean {
  return (
    phase === "checking" ||
    phase === "available" ||
    phase === "downloading"
  );
}

export function VersionGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [updaterPhase, setUpdaterPhase] = useState<UpdaterPhase | null>(null);
  /** Sticky once electron-updater finishes — survives later check/available events. */
  const [updateReady, setUpdateReady] = useState(false);
  const updateReadyRef = useRef(false);
  const lastCheckRef = useRef(0);
  const busyRef = useRef(false);
  const forceDownloadStartedRef = useRef(false);

  const applyStatus = useEffectEvent((next: StatusPayload) => {
    setStatus(next);
    lastCheckRef.current = Date.now();
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

  const startUpdateDownload = useCallback(async () => {
    if (updateReadyRef.current) return;
    setUpdaterPhase((prev) =>
      prev === "error" || prev == null ? "checking" : prev,
    );
    try {
      await window.cmaeDesktop?.checkForUpdates?.();
    } catch {
      setUpdaterPhase("error");
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
      const phase = ev.phase;
      if (phase === "downloaded") {
        updateReadyRef.current = true;
        setUpdateReady(true);
        setUpdaterPhase("downloaded");
        void runCheck();
        return;
      }
      // Don't clobber "ready" when a later check emits checking/available again
      if (updateReadyRef.current) return;
      setUpdaterPhase(phase);
      if (phase === "available") {
        void runCheck();
      }
    });

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

  // Force lock: start in-app download immediately (no external link).
  useEffect(() => {
    if (!status?.forceLock || !isDesktopRuntime()) return;
    if (updateReady || updateReadyRef.current) return;
    if (forceDownloadStartedRef.current) return;
    if (updaterPhase === "error") return;
    forceDownloadStartedRef.current = true;
    void startUpdateDownload();
  }, [status?.forceLock, updateReady, updaterPhase, startUpdateDownload]);

  async function openLanding() {
    if (window.cmaeDesktop?.openExternal) {
      await window.cmaeDesktop.openExternal(LANDING_URL);
      return;
    }
    window.open(LANDING_URL, "_blank", "noopener,noreferrer");
  }

  async function installNow() {
    if (window.cmaeDesktop?.quitAndInstall) {
      await window.cmaeDesktop.quitAndInstall();
      return;
    }
    await openLanding();
  }

  async function retryDownload() {
    forceDownloadStartedRef.current = true;
    setUpdateReady(false);
    updateReadyRef.current = false;
    await startUpdateDownload();
  }

  const showForce = Boolean(status?.forceLock);
  const showSoft =
    Boolean(status?.softUpdate) && !showForce && isDesktopRuntime();

  const versionArgs = {
    current: formatVersionTag(status?.current ?? ""),
    latest: formatVersionLabel(status?.latest ?? ""),
  };

  const softBody =
    updateReady || updaterPhase === "downloaded"
      ? t("versionGate.softReady", versionArgs)
      : updaterPhase === "downloading" || updaterPhase === "available"
        ? t("versionGate.softDownloading", versionArgs)
        : t("versionGate.softLead", versionArgs);

  const forceBody =
    updateReady || updaterPhase === "downloaded"
      ? t("versionGate.forceReady", versionArgs)
      : updaterPhase === "error"
        ? t("versionGate.forceError", versionArgs)
        : isBusyPhase(updaterPhase)
          ? t("versionGate.forceDownloading", versionArgs)
          : t("versionGate.forceLead", versionArgs);

  const forceBusy = showForce && !updateReady && isBusyPhase(updaterPhase);
  const forceError = showForce && updaterPhase === "error" && !updateReady;

  return (
    <>
      {showSoft && status ? (
        <div className="cmae-version-banner" role="status">
          <p>{softBody}</p>
          {updateReady ? (
            <div className="cmae-version-banner-actions">
              <button
                type="button"
                className="is-primary"
                onClick={() => void installNow()}
              >
                {t("versionGate.installNow")}
              </button>
            </div>
          ) : null}
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
              <BrandMark size={28} className="cmae-version-lock-brand-mark" />
              {t("versionGate.brand")}
            </div>
            <h1 id="cmae-version-lock-title">{t("versionGate.title")}</h1>
            <p>{forceBody}</p>
            <div className="cmae-version-lock-actions">
              {updateReady ? (
                <button
                  type="button"
                  className="cmae-version-lock-btn"
                  onClick={() => void installNow()}
                >
                  {t("versionGate.installNow")}
                </button>
              ) : forceBusy ? (
                <button
                  type="button"
                  className="cmae-version-lock-btn is-busy"
                  disabled
                  aria-busy="true"
                >
                  <span className="cmae-version-lock-spinner" aria-hidden />
                  {t("versionGate.downloading")}
                </button>
              ) : forceError ? (
                <button
                  type="button"
                  className="cmae-version-lock-btn"
                  onClick={() => void retryDownload()}
                >
                  {t("versionGate.download")}
                </button>
              ) : (
                <button
                  type="button"
                  className="cmae-version-lock-btn"
                  onClick={() => void startUpdateDownload()}
                >
                  {t("versionGate.download")}
                </button>
              )}
              {!updateReady ? (
                <button
                  type="button"
                  className="cmae-version-lock-btn is-secondary"
                  disabled={forceBusy}
                  onClick={() => void openLanding()}
                >
                  {t("versionGate.openRelease")}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
