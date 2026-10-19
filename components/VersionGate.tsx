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
import type { VersionStatus } from "@/lib/version/policy";
import {
  formatVersionLabel,
  formatVersionTag,
} from "@/lib/version/semver";
import "./version-gate.css";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FOCUS_MIN_GAP_MS = 60 * 60 * 1000;

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

export function VersionGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [updaterPhase, setUpdaterPhase] = useState<UpdaterPhase | null>(null);
  /** Sticky once electron-updater finishes — survives later check/available events. */
  const [updateReady, setUpdateReady] = useState(false);
  const updateReadyRef = useRef(false);
  const lastCheckRef = useRef(0);
  const busyRef = useRef(false);

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
        : updaterPhase === "downloading" || updaterPhase === "available"
          ? t("versionGate.forceDownloading", versionArgs)
          : t("versionGate.forceLead", versionArgs);

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
            {status.notes ? (
              <>
                <p className="cmae-version-lock-meta">
                  {t("versionGate.notes")}
                </p>
                <pre className="cmae-version-lock-notes">{status.notes}</pre>
              </>
            ) : null}
            <div className="cmae-version-lock-actions">
              {updateReady ? (
                <button
                  type="button"
                  className="cmae-version-lock-btn"
                  onClick={() => void installNow()}
                >
                  {t("versionGate.installNow")}
                </button>
              ) : null}
              {updaterPhase === "error" ? (
                <button
                  type="button"
                  className="cmae-version-lock-btn"
                  onClick={() => void openDownload()}
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
