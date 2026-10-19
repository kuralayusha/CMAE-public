"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useIntlLocale, useLocaleUpper, useT } from "@/components/I18nProvider";
import { RichText } from "@/components/RichText";
import { SyncTerminal } from "@/components/SyncTerminal";
import { HoverTip } from "@/components/HoverTip";
import { TruncateTip } from "@/components/TruncateTip";
import { Button } from "@/components/ui";
import {
  listVariantMeta,
  pickDefaultVariantId,
  type DraftPrepareKind,
  type DraftVariantId,
  type DraftVariantMeta,
} from "@/lib/tracker/draft-variants";
import type { SyncLogLine } from "@/lib/tracker/types";
import type { TVars } from "@/lib/i18n/lookup";
import "./tracker-list.css";

function IconGmail({ count }: { count?: number }) {
  return (
    <span className="cmae-tracker-ico-wrap">
      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
        <path
          fill="currentColor"
          d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2Zm0 4-8 5L4 8V6l8 5 8-5v2Z"
        />
      </svg>
      {count && count > 1 ? (
        <span className="cmae-tracker-ico-badge">{count}</span>
      ) : null}
    </span>
  );
}

function IconSync() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"
      />
    </svg>
  );
}

function IconPrepare() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z"
      />
    </svg>
  );
}

function IconDraft() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"
      />
    </svg>
  );
}

function IconWait() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2ZM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8Zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7Z"
      />
    </svg>
  );
}

function IconSpinner() {
  return (
    <svg
      className="cmae-tracker-spinner"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="40 20"
        opacity="0.9"
      />
    </svg>
  );
}

type SyncTermStatus = "running" | "done" | "error" | "canceled";

type TrackerItem = {
  id: number;
  company: string;
  position: string | null;
  status: string;
  sentiment: string | null;
  waitingOn: string | null;
  followUpCount: number;
  lastOutboundAt: string | null;
  lastInboundAt: string | null;
  nextFollowUpAt: string | null;
  ignored: boolean;
  workspaceFolder: string | null;
  primaryTo: string | null;
  hasFollowUpDraft: boolean;
  hasThanksDraft: boolean;
  hasReplyDraft: boolean;
  lastActivityAt: string | null;
  statusLabel: string;
  gmailUrls?: string[];
  waitingUntil?: string | null;
  pendingGmailDraft?: {
    kind: "follow_up" | "thanks" | "reply";
    at: string;
    subject: string;
    draftsUrl?: string;
  } | null;
};

/** Open tab under the click gesture, then navigate after async work (avoids popup block).
 * Do not use noopener — we need the Window handle to set location after fetch. */
function openTabForAsyncUrl(): Window | null {
  try {
    return window.open("about:blank", "_blank");
  } catch {
    return null;
  }
}

function navigateOpenedTab(popup: Window | null, url: string | null | undefined) {
  if (!url) {
    popup?.close();
    return false;
  }
  if (popup && !popup.closed) {
    try {
      popup.location.href = url;
      return true;
    } catch {
      popup.close();
    }
  }
  return false;
}

type GmailModalState = {
  company: string;
  urls: string[];
};

type PrepareModalState = {
  item: TrackerItem;
  kind: DraftPrepareKind;
  step: "pick" | "note";
  variants: DraftVariantMeta[];
  selected: DraftVariantId;
  suggested: DraftVariantId;
  userNote: string;
  eventKinds: string[];
};

type Section = {
  status: string;
  title: string;
  items: TrackerItem[];
};

type SyncMeta = {
  lastSyncAt: string | null;
  lastError: string | null;
  windowDays: number;
};

type SyncStreamResult = {
  skippedImap?: boolean;
  skipReason?: string;
  upserted?: number;
  itemCount?: number;
  mode?: "incremental" | "hard";
  keptOutsideWindow?: number;
  sections?: Section[];
  sync?: SyncMeta;
  total?: number;
};

function formatWhen(iso: string | null, locale: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(locale, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function statusDetail(
  item: TrackerItem,
  t: (key: string, vars?: TVars) => string,
  locale: string,
): string {
  if (item.status === "needs_reply" && item.sentiment) {
    const key =
      item.sentiment === "positive" || item.sentiment === "negative"
        ? item.sentiment
        : "neutral";
    return t(`tracker.sentiment.${key}`);
  }
  if (item.status === "waiting" && item.waitingUntil) {
    try {
      return new Date(`${item.waitingUntil}T12:00:00`).toLocaleDateString(
        locale,
        { day: "2-digit", month: "short" },
      );
    } catch {
      return item.waitingUntil;
    }
  }
  if (item.status === "in_progress" && item.nextFollowUpAt) {
    const unlock = Date.parse(item.nextFollowUpAt);
    if (Number.isFinite(unlock) && unlock > Date.now()) {
      try {
        return t("tracker.detail.fu", {
          date: new Date(unlock).toLocaleDateString(locale, {
            day: "2-digit",
            month: "short",
          }),
        });
      } catch {
        return t("tracker.detail.fuPending");
      }
    }
  }
  if (item.status === "in_progress" && item.waitingOn) {
    return item.waitingOn === "us"
      ? t("tracker.detail.waitingOnUs")
      : t("tracker.detail.waitingOnThem");
  }
  if (item.status === "follow_up_due" && item.followUpCount > 0) {
    return `${item.followUpCount}/2`;
  }
  return "";
}

export function TrackerList() {
  const t = useT();
  const upper = useLocaleUpper();
  const locale = useIntlLocale();
  const [sections, setSections] = useState<Section[]>([]);
  const [sync, setSync] = useState<SyncMeta | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncLines, setSyncLines] = useState<SyncLogLine[]>([]);
  const [syncTermStatus, setSyncTermStatus] = useState<SyncTermStatus | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [gmailModal, setGmailModal] = useState<GmailModalState | null>(null);
  const [prepareModal, setPrepareModal] = useState<PrepareModalState | null>(
    null,
  );
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [syncSessionId, setSyncSessionId] = useState<string | null>(null);
  const [hardSync, setHardSync] = useState(false);
  const syncEsRef = useRef<EventSource | null>(null);
  const liveEsRef = useRef<EventSource | null>(null);
  const syncShowToastRef = useRef(false);

  const allItems = useMemo(
    () => sections.flatMap((s) => s.items),
    [sections],
  );

  const selectedItems = useMemo(
    () => allItems.filter((i) => selectedIds.has(i.id)),
    [allItems, selectedIds],
  );

  useEffect(() => {
    const alive = new Set(allItems.map((i) => i.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<number>();
      for (const id of prev) {
        if (alive.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [allItems]);

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulkSet(action: "inactive" | "active") {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBulkBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/tracker/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("tracker.error.bulkFailed"));
      if (data.sections) {
        setSections(data.sections);
        setSync(data.sync || null);
        setTotal(data.total || 0);
      } else {
        await load();
      }
      setSelectedIds(new Set());
      setToast(
        action === "inactive"
          ? t("tracker.toast.markedInactive", {
              count: data.updated ?? ids.length,
            })
          : t("tracker.toast.markedActive", {
              count: data.updated ?? ids.length,
            }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
    }
  }

  useEffect(() => {
    if (!gmailModal && !prepareModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (prepareModal) {
        if (prepareModal.step === "note") {
          setPrepareModal({ ...prepareModal, step: "pick", userNote: "" });
        } else {
          setPrepareModal(null);
        }
        return;
      }
      setGmailModal(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gmailModal, prepareModal]);

  const prepareModalItemId = prepareModal?.item.id ?? null;
  const prepareModalKind = prepareModal?.kind ?? null;
  const prepareModalFollowUpCount = prepareModal?.item.followUpCount ?? 0;

  useEffect(() => {
    if (prepareModalItemId == null || !prepareModalKind) return;
    let cancelled = false;
    const itemId = prepareModalItemId;
    const kind = prepareModalKind;
    const followUpCount = prepareModalFollowUpCount;

    void (async () => {
      try {
        const res = await fetch(`/api/tracker/${itemId}/timeline`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          events?: { kind?: string }[];
        };
        const eventKinds = (data.events || [])
          .map((e) => e.kind)
          .filter((k): k is string => Boolean(k));
        if (cancelled || !eventKinds.length) return;
        const suggested = pickDefaultVariantId(kind, {
          followUpCount,
          eventKinds,
        });
        setPrepareModal((prev) => {
          if (!prev || prev.item.id !== itemId || prev.kind !== kind) {
            return prev;
          }
          if (prev.step !== "pick") return { ...prev, eventKinds };
          const nextSelected =
            prev.selected === prev.suggested ? suggested : prev.selected;
          return {
            ...prev,
            eventKinds,
            suggested,
            selected: nextSelected,
          };
        });
      } catch {
        /* timeline is best-effort for suggestions */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [prepareModalItemId, prepareModalKind, prepareModalFollowUpCount]);

  const load = useCallback(async () => {
    const res = await fetch("/api/tracker");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t("tracker.error.loadList"));
    setSections(data.sections || []);
    setSync(data.sync || null);
    setTotal(data.total || 0);
  }, []);

  const pendingDraftCount = useMemo(
    () => allItems.filter((i) => Boolean(i.pendingGmailDraft)).length,
    [allItems],
  );

  // Prepare may finish while the user is on another page — refresh flags/buttons.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void load().catch(() => {
        /* keep prior list */
      });
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  const applySyncPayload = useCallback(
    (data: {
      sections?: Section[];
      sync?: SyncMeta;
      total?: number;
      skippedImap?: boolean;
      skipReason?: string;
      upserted?: number;
      itemCount?: number;
      showToast?: boolean;
      mode?: "incremental" | "hard";
      keptOutsideWindow?: number;
    }) => {
      setSections(data.sections || []);
      setSync(data.sync || null);
      setTotal(data.total || 0);
      if (data.showToast) {
        const parts = [
          data.mode === "hard"
            ? t("tracker.toast.syncLabelHard")
            : t("tracker.toast.syncLabel"),
          data.skippedImap
            ? `${t("tracker.toast.syncImapSkipped")}${data.skipReason ? `: ${data.skipReason}` : ""}`
            : t("tracker.toast.syncUpsert", { count: data.upserted ?? 0 }),
          t("tracker.toast.syncRows", {
            count: data.itemCount ?? data.total ?? 0,
          }),
        ];
        if (
          typeof data.keptOutsideWindow === "number" &&
          data.keptOutsideWindow > 0
        ) {
          parts.push(
            t("tracker.toast.syncOlderKept", {
              count: data.keptOutsideWindow,
            }),
          );
        }
        setToast(parts.join(" · "));
      }
    },
    [t],
  );

  const detachSyncStream = useCallback(() => {
    if (syncEsRef.current) {
      syncEsRef.current.close();
      syncEsRef.current = null;
    }
  }, []);

  const attachSyncStream = useCallback(
    (id: string, opts?: { showToast?: boolean }) => {
      detachSyncStream();
      syncShowToastRef.current = Boolean(opts?.showToast);
      setSyncSessionId(id);
      setSyncing(true);
      setSyncTermStatus("running");

      const es = new EventSource(`/api/tracker/sync/${id}/stream`);
      syncEsRef.current = es;

      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as {
            type: string;
            session?: {
              id: string;
              status: SyncTermStatus;
              lines: SyncLogLine[];
              error: string | null;
              result: SyncStreamResult | null;
            };
            line?: SyncLogLine;
            result?: SyncStreamResult;
            error?: string;
            status?: SyncTermStatus;
          };

          if (data.type === "hello" && data.session) {
            setSyncLines(data.session.lines || []);
            setSyncTermStatus(data.session.status);
            setSyncing(data.session.status === "running");
            if (data.session.result) {
              applySyncPayload({
                ...data.session.result,
                showToast: syncShowToastRef.current,
              });
            }
            if (data.session.error && data.session.status === "error") {
              setError(data.session.error);
            }
          } else if (data.type === "line" && data.line) {
            setSyncLines((prev) => {
              if (prev.some((l) => l.id === data.line!.id)) return prev;
              return [...prev, data.line!];
            });
          } else if (data.type === "result" && data.result) {
            applySyncPayload({
              ...data.result,
              showToast: syncShowToastRef.current,
            });
          } else if (data.type === "error" && data.error) {
            setError(data.error);
          } else if (data.type === "done" && data.status) {
            setSyncTermStatus(data.status);
            setSyncing(false);
            es.close();
            if (syncEsRef.current === es) syncEsRef.current = null;
            if (data.status === "error" || data.status === "done") {
              void load();
            }
          }
        } catch {
          /* ignore */
        }
      };

      es.onerror = () => {
        // Browser may retry; if session gone, close quietly
        if (es.readyState === EventSource.CLOSED) {
          setSyncing(false);
          setSyncTermStatus((s) => (s === "running" ? "error" : s));
        }
      };
    },
    [applySyncPayload, detachSyncStream, load],
  );

  const cancelSync = useCallback(async () => {
    const id = syncSessionId;
    if (!id) return;
    try {
      await fetch(`/api/tracker/sync/${id}/cancel`, { method: "POST" });
    } catch {
      /* stream will still flip to canceled if server got it */
    }
  }, [syncSessionId]);

  const runSync = useCallback(
    async (opts?: { quiet?: boolean; mode?: "incremental" | "hard" }) => {
      const mode = opts?.mode ?? "incremental";
      setError(null);
      if (!opts?.quiet) setToast(null);
      setSyncLines([]);
      setSyncTermStatus("running");
      setSyncing(true);
      try {
        const res = await fetch("/api/tracker/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || t("tracker.error.startSync"));
        attachSyncStream(data.id as string, { showToast: !opts?.quiet });
      } catch (err) {
        setSyncing(false);
        setSyncTermStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [attachSyncStream],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        await load();
        if (cancelled) return;
        const res = await fetch("/api/tracker/sync");
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && data.active?.id && data.active.status === "running") {
          attachSyncStream(data.active.id as string, { showToast: false });
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    // Research light-merge → refresh list immediately (not a Gmail sync)
    const live = new EventSource("/api/tracker/live");
    liveEsRef.current = live;
    live.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as { type?: string };
        if (data.type === "research_merged" || data.type === "refresh") {
          void load().catch(() => {
            /* keep prior list */
          });
        }
      } catch {
        /* ignore malformed */
      }
    };

    return () => {
      cancelled = true;
      // Only detach UI stream — do NOT cancel the server sync
      detachSyncStream();
      if (liveEsRef.current) {
        liveEsRef.current.close();
        liveEsRef.current = null;
      }
    };
    // mount-only bootstrap
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openPrepareModal(item: TrackerItem, kind: DraftPrepareKind) {
    const variants = listVariantMeta(kind);
    const suggested = pickDefaultVariantId(kind, {
      followUpCount: item.followUpCount,
    });
    setPrepareModal({
      item,
      kind,
      step: "pick",
      variants,
      selected: suggested,
      suggested,
      userNote: "",
      eventKinds: [],
    });
  }

  async function prepare(
    item: TrackerItem,
    kind: DraftPrepareKind,
    variant: DraftVariantId,
    userNote: string,
    eventKinds: string[],
  ) {
    const key = `${item.id}:prep:${kind}`;
    setBusyId(key);
    setError(null);
    setPrepareModal(null);
    try {
      const res = await fetch(`/api/tracker/${item.id}/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          variant,
          userNote: userNote.trim() || undefined,
          eventKinds: eventKinds.length ? eventKinds : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("tracker.error.prepare"));
      setToast(t("tracker.toast.draftWritten", { file: data.fileName }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function draft(
    item: TrackerItem,
    kind: "application" | "follow_up" | "thanks" | "reply",
  ) {
    const key = `${item.id}:draft:${kind}`;
    setBusyId(key);
    setError(null);
    const popup = openTabForAsyncUrl();
    try {
      const res = await fetch(`/api/tracker/${item.id}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("tracker.error.gmailDraft"));
      const bits = [
        kind === "application"
          ? t("tracker.toast.gmailDraft", { subject: data.subject })
          : t("tracker.toast.gmailDraftPending", { subject: data.subject }),
      ];
      if (data.attachedCv) {
        bits.push(t("tracker.toast.attachment", { name: data.attachedCv }));
      }
      if (data.cvWarning) bits.push(String(data.cvWarning));
      const opened = navigateOpenedTab(popup, data.gmailUrl);
      if (!opened && data.gmailUrl) {
        bits.push(t("tracker.pendingDraft.popupBlocked"));
      }
      setToast(bits.join(" · "));
      await load();
    } catch (err) {
      popup?.close();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  /** Pending clock: open Gmail Drafts; recreate from .md if the draft was deleted. */
  async function openPendingDraft(item: TrackerItem) {
    const pending = item.pendingGmailDraft;
    if (!pending) return;
    const key = `${item.id}:draft:${pending.kind}`;
    setBusyId(key);
    setError(null);
    const popup = openTabForAsyncUrl();
    try {
      const res = await fetch(`/api/tracker/${item.id}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: pending.kind, ensure: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("tracker.error.gmailDraft"));
      if (data.reused === false) {
        setToast(t("tracker.action.pendingRecreating"));
      }
      const url = data.gmailUrl || pending.draftsUrl;
      const opened = navigateOpenedTab(popup, url);
      if (!opened && url) {
        setToast(t("tracker.pendingDraft.popupBlocked"));
      }
      await load();
    } catch (err) {
      popup?.close();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  function renderGmailOpen(item: TrackerItem) {
    const urls = [...new Set((item.gmailUrls || []).filter(Boolean))];
    if (!urls.length) return null;

    if (urls.length === 1) {
      return (
        <HoverTip label={t("tracker.action.openGmail")}>
          <a
            className="cmae-btn cmae-btn-ghost cmae-tracker-icon-btn"
            href={urls[0]}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t("tracker.action.openGmail")}
            onClick={(e) => e.stopPropagation()}
          >
            <IconGmail />
          </a>
        </HoverTip>
      );
    }

    const label = t("tracker.action.openGmailN", { count: urls.length });
    return (
      <HoverTip label={label}>
        <Button
          type="button"
          variant="ghost"
          className="cmae-tracker-icon-btn"
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation();
            setGmailModal({ company: item.company, urls });
          }}
        >
          <IconGmail count={urls.length} />
        </Button>
      </HoverTip>
    );
  }

  function renderPrimaryAction(item: TrackerItem) {
    if (item.status === "inactive") return null;

    const busy = busyId?.startsWith(`${item.id}:`);
    const spinning = Boolean(busy);

    if (item.pendingGmailDraft) {
      const label = t("tracker.action.pendingSend");
      return (
        <HoverTip label={label}>
          <Button
            type="button"
            variant="ghost"
            className="cmae-tracker-icon-btn"
            disabled={spinning}
            aria-label={label}
            onClick={(e) => {
              e.stopPropagation();
              void openPendingDraft(item);
            }}
          >
            {busyId === `${item.id}:draft:${item.pendingGmailDraft.kind}` ? (
              <IconSpinner />
            ) : (
              <IconWait />
            )}
          </Button>
        </HoverTip>
      );
    }

    if (item.status === "ready_to_send") {
      const label = t("tracker.action.createDraft");
      return (
        <HoverTip label={label}>
          <Button
            type="button"
            className="cmae-tracker-icon-btn"
            disabled={spinning}
            aria-label={label}
            onClick={(e) => {
              e.stopPropagation();
              void draft(item, "application");
            }}
          >
            {busyId === `${item.id}:draft:application` ? (
              <IconSpinner />
            ) : (
              <IconDraft />
            )}
          </Button>
        </HoverTip>
      );
    }

    if (item.status === "follow_up_due") {
      if (!item.hasFollowUpDraft) {
        const label = t("tracker.action.prepareFollowUp");
        return (
          <HoverTip label={label}>
            <Button
              type="button"
              variant="ghost"
              className="cmae-tracker-icon-btn"
              disabled={spinning}
              aria-label={label}
              onClick={(e) => {
                e.stopPropagation();
                openPrepareModal(item, "follow_up");
              }}
            >
              {busyId === `${item.id}:prep:follow_up` ? (
                <IconSpinner />
              ) : (
                <IconPrepare />
              )}
            </Button>
          </HoverTip>
        );
      }
      const label = t("tracker.action.draftFollowUp");
      return (
        <HoverTip label={label}>
          <Button
            type="button"
            className="cmae-tracker-icon-btn"
            disabled={spinning}
            aria-label={label}
            onClick={(e) => {
              e.stopPropagation();
              void draft(item, "follow_up");
            }}
          >
            {busyId === `${item.id}:draft:follow_up` ? (
              <IconSpinner />
            ) : (
              <IconDraft />
            )}
          </Button>
        </HoverTip>
      );
    }

    if (item.status === "needs_action") {
      return null;
    }

    if (
      item.status === "needs_reply" ||
      item.status === "in_progress" ||
      item.status === "waiting"
    ) {
      if (item.status === "waiting") {
        const label = t("tracker.action.waitingUntil");
        return (
          <HoverTip label={label}>
            <span
              className="cmae-tracker-icon-btn is-static"
              aria-label={t("tracker.action.waiting")}
            >
              <IconWait />
            </span>
          </HoverTip>
        );
      }
      if (!item.hasReplyDraft) {
        const label = t("tracker.action.prepareReply");
        return (
          <HoverTip label={label}>
            <Button
              type="button"
              variant="ghost"
              className="cmae-tracker-icon-btn"
              disabled={spinning}
              aria-label={label}
              onClick={(e) => {
                e.stopPropagation();
                openPrepareModal(item, "reply");
              }}
            >
              {busyId === `${item.id}:prep:reply` ? (
                <IconSpinner />
              ) : (
                <IconPrepare />
              )}
            </Button>
          </HoverTip>
        );
      }
      const label = t("tracker.action.draftReply");
      return (
        <HoverTip label={label}>
          <Button
            type="button"
            className="cmae-tracker-icon-btn"
            disabled={spinning}
            aria-label={label}
            onClick={(e) => {
              e.stopPropagation();
              void draft(item, "reply");
            }}
          >
            {busyId === `${item.id}:draft:reply` ? (
              <IconSpinner />
            ) : (
              <IconDraft />
            )}
          </Button>
        </HoverTip>
      );
    }

    if (item.status === "rejected") {
      if (!item.hasThanksDraft) {
        const label = t("tracker.action.prepareThanks");
        return (
          <HoverTip label={label}>
            <Button
              type="button"
              variant="ghost"
              className="cmae-tracker-icon-btn"
              disabled={spinning}
              aria-label={label}
              onClick={(e) => {
                e.stopPropagation();
                openPrepareModal(item, "thanks");
              }}
            >
              {busyId === `${item.id}:prep:thanks` ? (
                <IconSpinner />
              ) : (
                <IconPrepare />
              )}
            </Button>
          </HoverTip>
        );
      }
      const label = t("tracker.action.draftThanks");
      return (
        <HoverTip label={label}>
          <Button
            type="button"
            className="cmae-tracker-icon-btn"
            disabled={spinning}
            aria-label={label}
            onClick={(e) => {
              e.stopPropagation();
              void draft(item, "thanks");
            }}
          >
            {busyId === `${item.id}:draft:thanks` ? (
              <IconSpinner />
            ) : (
              <IconDraft />
            )}
          </Button>
        </HoverTip>
      );
    }

    return null;
  }

  function renderActions(item: TrackerItem) {
    const gmailBtn = renderGmailOpen(item);
    const primary = renderPrimaryAction(item);
    if (!gmailBtn && !primary) {
      return <span className="cmae-tracker-action-empty">—</span>;
    }
    return (
      <>
        {gmailBtn}
        {primary}
      </>
    );
  }

  function renderRow(item: TrackerItem) {
    const chipKey = `tracker.chip.${item.status}`;
    const chip = t(chipKey);
    const label = chip === chipKey ? item.status.replace(/_/g, " ") : chip;
    const sectionKey = `tracker.section.${item.status}`;
    const sectionTitle = t(sectionKey);
    const statusTitle =
      sectionTitle === sectionKey
        ? item.statusLabel || label
        : sectionTitle;
    const detail = statusDetail(item, t, locale);
    const tip = [statusTitle, detail].filter(Boolean).join(" · ");
    const checked = selectedIds.has(item.id);
    return (
      <div
        key={item.id}
        className={`cmae-tracker-row is-clickable${item.status === "ignored" ? " is-ignored" : ""}${checked ? " is-selected" : ""}${item.status === "inactive" ? " is-inactive" : ""}`}
        role="row"
        tabIndex={0}
        onClick={() => {
          window.open(`/tracker/${item.id}`, "_blank", "noopener,noreferrer");
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            window.open(`/tracker/${item.id}`, "_blank", "noopener,noreferrer");
          }
        }}
        aria-label={t("tracker.detailPage.openRow", { company: item.company })}
      >
        <span
          className="cmae-tracker-check"
          role="cell"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            className="cmae-tracker-checkbox"
            checked={checked}
            onChange={() => toggleSelect(item.id)}
            aria-label={t("tracker.sel.selectCompany", {
              company: item.company,
            })}
          />
        </span>
        <span className="cmae-tracker-company" role="cell">
          <TruncateTip text={item.company} />
        </span>
        <span className="cmae-tracker-muted" role="cell">
          <TruncateTip text={item.position || "—"} />
        </span>
        <span className="cmae-tracker-status-cell" role="cell" title={tip}>
          <span
            className="cmae-status-chip"
            data-status={item.status}
          >
            {label}
          </span>
          {detail ? (
            <span className="cmae-status-detail">{detail}</span>
          ) : null}
        </span>
        <span className="cmae-tracker-muted" role="cell">
          <TruncateTip text={formatWhen(item.lastActivityAt, locale)} />
        </span>
        <span className="cmae-tracker-muted" role="cell">
          <TruncateTip text={item.primaryTo || "—"} />
        </span>
        <span
          className="cmae-tracker-actions"
          role="cell"
          onClick={(e) => e.stopPropagation()}
        >
          {renderActions(item)}
        </span>
      </div>
    );
  }

  function renderTable(items: TrackerItem[]) {
    return (
      <div className="cmae-tracker-table" role="table">
        <div className="cmae-tracker-row is-head" role="row">
          <span role="columnheader" className="cmae-tracker-check">
            <span className="cmae-sr-only">{t("tracker.col.select")}</span>
          </span>
          <span role="columnheader">{upper(t("tracker.col.company"))}</span>
          <span role="columnheader">{upper(t("tracker.col.position"))}</span>
          <span role="columnheader">{upper(t("tracker.col.status"))}</span>
          <span role="columnheader">{upper(t("tracker.col.lastActivity"))}</span>
          <span role="columnheader">{upper(t("tracker.col.recipient"))}</span>
          <span role="columnheader">{upper(t("tracker.col.action"))}</span>
        </div>
        {items.map(renderRow)}
      </div>
    );
  }

  const selectedCount = selectedIds.size;
  const selectedHasActive = selectedItems.some((i) => i.status !== "inactive");
  const selectedHasInactive = selectedItems.some((i) => i.status === "inactive");

  return (
    <div className="cmae-tracker">
      {selectedCount > 0 ? (
        <div
          className="cmae-tracker-selbar"
          role="region"
          aria-label={t("tracker.sel.aria")}
        >
          <div className="cmae-tracker-selbar-inner">
            <span className="cmae-tracker-selbar-count">
              {t("tracker.sel.count", { count: selectedCount })}
            </span>
            <div className="cmae-tracker-selbar-actions">
              {selectedHasActive ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={bulkBusy}
                  onClick={() => void bulkSet("inactive")}
                >
                  {t("tracker.sel.markInactive")}
                </Button>
              ) : null}
              {selectedHasInactive ? (
                <Button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => void bulkSet("active")}
                >
                  {t("tracker.sel.markActive")}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                disabled={bulkBusy}
                onClick={() => setSelectedIds(new Set())}
              >
                {t("tracker.sel.clear")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {!loading && total > 0 ? (
        <div className="cmae-tracker-toolbar">
          <div className="cmae-tracker-meta">
            <span>{t("tracker.metaCount", { count: total })}</span>
            <span className="cmae-tracker-dot">·</span>
            <span>
              {t("tracker.metaLastSync")}{" "}
              {sync?.lastSyncAt
                ? formatWhen(sync.lastSyncAt, locale)
                : t("tracker.metaNoneYet")}
            </span>
            {sync?.lastError ? (
              <>
                <span className="cmae-tracker-dot">·</span>
                <span className="cmae-tracker-err">{sync.lastError}</span>
              </>
            ) : null}
          </div>
          <div className="cmae-tracker-toolbar-right">
            <div className="cmae-tracker-sync-controls">
              <div
                className={`cmae-tracker-hard-sync${hardSync ? " is-on" : ""}`}
              >
                <button
                  type="button"
                  role="switch"
                  className={`cmae-tracker-switch-btn${hardSync ? " is-on" : ""}`}
                  aria-checked={hardSync}
                  aria-label={t("tracker.hardSyncToggle")}
                  title={t("tracker.hardSyncTitle")}
                  disabled={syncing || loading}
                  onClick={() => setHardSync((v) => !v)}
                >
                  <span className="cmae-tracker-switch-knob" aria-hidden />
                </button>
                <div className="cmae-tracker-hard-sync-text">
                  <span className="cmae-tracker-hard-sync-label">
                    {t("tracker.hardSyncToggle")}
                  </span>
                  <span className="cmae-tracker-hard-sync-hint">
                    {t("tracker.hardSyncHint")}
                  </span>
                </div>
              </div>
              <Button
                type="button"
                className="cmae-tracker-icon-btn"
                onClick={() => {
                  const mode = hardSync ? "hard" : "incremental";
                  setHardSync(false);
                  void runSync({ mode });
                }}
                disabled={syncing || loading}
                title={
                  hardSync ? t("tracker.hardSyncTitle") : t("tracker.syncTitle")
                }
                aria-label={
                  hardSync ? t("tracker.hardSync") : t("tracker.sync")
                }
              >
                {syncing ? <IconSpinner /> : <IconSync />}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {error ? <p className="cmae-tracker-banner is-error">{error}</p> : null}
      {toast ? <p className="cmae-tracker-banner">{toast}</p> : null}
      {!loading && pendingDraftCount > 0 ? (
        <div className="cmae-tracker-banner cmae-tracker-pending-banner">
          <p>{t("tracker.pendingDraft.banner")}</p>
          <Button
            type="button"
            onClick={() => void runSync({ mode: "incremental" })}
            disabled={syncing}
          >
            {syncing
              ? t("tracker.pendingDraft.syncing")
              : t("tracker.pendingDraft.cta")}
          </Button>
        </div>
      ) : null}

      {gmailModal ? (
        <div
          className="cmae-gmail-modal-backdrop"
          role="presentation"
          onClick={() => setGmailModal(null)}
        >
          <div
            className="cmae-gmail-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cmae-gmail-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="cmae-gmail-modal-head">
              <div>
                <h2 id="cmae-gmail-modal-title">
                  {t("tracker.gmailModal.title")}
                </h2>
                <p>
                  <RichText
                    text={t("tracker.gmailModalLead")}
                    parts={{
                      company: gmailModal.company,
                      count: String(gmailModal.urls.length),
                      mod: (
                        <>
                          <kbd className="cmae-kbd">
                            {t("tracker.gmailModal.modMac")}
                          </kbd>
                          /
                          <kbd className="cmae-kbd">
                            {t("tracker.gmailModal.modWin")}
                          </kbd>
                        </>
                      ),
                    }}
                  />
                </p>
              </div>
              <button
                type="button"
                className="cmae-gmail-modal-close"
                onClick={() => setGmailModal(null)}
                aria-label={t("common.close")}
              >
                ×
              </button>
            </header>
            <div className="cmae-gmail-modal-list">
              {gmailModal.urls.map((url, i) => (
                <a
                  key={url}
                  className="cmae-btn cmae-btn-ghost cmae-gmail-modal-link"
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("tracker.gmailModal.threadLink", { n: i + 1 })}
                </a>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {prepareModal ? (
        <div
          className="cmae-gmail-modal-backdrop"
          role="presentation"
          onClick={() => setPrepareModal(null)}
        >
          <div
            className="cmae-gmail-modal cmae-prepare-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cmae-prepare-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="cmae-gmail-modal-head">
              <div>
                <h2 id="cmae-prepare-modal-title">
                  {prepareModal.step === "pick"
                    ? prepareModal.kind === "follow_up"
                      ? t("tracker.variantModal.titleFollowUp")
                      : prepareModal.kind === "thanks"
                        ? t("tracker.variantModal.titleThanks")
                        : t("tracker.variantModal.titleReply")
                    : (() => {
                        const meta = prepareModal.variants.find(
                          (v) => v.id === prepareModal.selected,
                        );
                        return meta?.noteRecommended
                          ? t("tracker.variantNote.titleRecommended")
                          : t("tracker.variantNote.title");
                      })()}
                </h2>
                <p>
                  {prepareModal.step === "pick"
                    ? t("tracker.variantModal.lead")
                    : (() => {
                        const meta = prepareModal.variants.find(
                          (v) => v.id === prepareModal.selected,
                        );
                        return meta?.noteRecommended
                          ? t("tracker.variantNote.recommended")
                          : t(meta?.hintKey || "tracker.variantModal.lead");
                      })()}
                </p>
              </div>
              <button
                type="button"
                className="cmae-gmail-modal-close"
                onClick={() => setPrepareModal(null)}
                aria-label={t("common.close")}
              >
                ×
              </button>
            </header>

            {prepareModal.step === "pick" ? (
              <div className="cmae-prepare-variant-list">
                {prepareModal.variants.map((v) => {
                  const isSelected = prepareModal.selected === v.id;
                  const isSuggested = prepareModal.suggested === v.id;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      className={`cmae-prepare-variant${isSelected ? " is-selected" : ""}`}
                      onClick={() =>
                        setPrepareModal({
                          ...prepareModal,
                          selected: v.id,
                          step: "note",
                          userNote: "",
                        })
                      }
                    >
                      <span className="cmae-prepare-variant-top">
                        <span className="cmae-prepare-variant-label">
                          {t(v.labelKey)}
                        </span>
                        {isSuggested ? (
                          <span className="cmae-prepare-variant-badge">
                            {t("tracker.variantModal.suggested")}
                          </span>
                        ) : null}
                      </span>
                      <span className="cmae-prepare-variant-hint">
                        {t(v.hintKey)}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="cmae-prepare-note">
                <textarea
                  className="cmae-prepare-note-input"
                  rows={5}
                  value={prepareModal.userNote}
                  placeholder={t(
                    prepareModal.variants.find(
                      (v) => v.id === prepareModal.selected,
                    )?.placeholderKey || "",
                  )}
                  onChange={(e) =>
                    setPrepareModal({
                      ...prepareModal,
                      userNote: e.target.value,
                    })
                  }
                  autoFocus
                />
                <div className="cmae-prepare-note-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      setPrepareModal({
                        ...prepareModal,
                        step: "pick",
                        userNote: "",
                      })
                    }
                  >
                    {t("tracker.variantNote.back")}
                  </Button>
                  <Button
                    type="button"
                    disabled={Boolean(
                      busyId?.startsWith(`${prepareModal.item.id}:prep:`),
                    )}
                    onClick={() =>
                      void prepare(
                        prepareModal.item,
                        prepareModal.kind,
                        prepareModal.selected,
                        prepareModal.userNote,
                        prepareModal.eventKinds,
                      )
                    }
                  >
                    {busyId?.startsWith(`${prepareModal.item.id}:prep:`)
                      ? t("tracker.variantNote.preparing")
                      : t("tracker.variantNote.prepare")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {syncTermStatus ? (
        <div className="cmae-tracker-sync-term">
          <SyncTerminal
            lines={syncLines}
            status={syncTermStatus}
            onCancel={syncTermStatus === "running" ? cancelSync : undefined}
            onDismiss={
              syncTermStatus === "running"
                ? undefined
                : () => setSyncTermStatus(null)
            }
          />
        </div>
      ) : null}

      {loading ? (
        <p className="cmae-tracker-empty">{t("tracker.loading")}</p>
      ) : total === 0 ? (
        <div className="cmae-tracker-empty cmae-tracker-empty-cta">
          <p>{t("tracker.empty")}</p>
          <p className="cmae-tracker-empty-hint">{t("tracker.emptyHint")}</p>
          <div className="cmae-tracker-empty-actions">
            <Button
              type="button"
              onClick={() => void runSync({ mode: "incremental" })}
              disabled={syncing}
              title={t("tracker.syncTitle")}
            >
              {syncing ? t("tracker.syncing") : t("tracker.sync")}
            </Button>
          </div>
        </div>
      ) : (
        sections.map((section) => {
          const sectionKey = `tracker.section.${section.status}`;
          const title = t(sectionKey);
          return (
            <section key={section.status} className="cmae-tracker-section">
              <header className="cmae-tracker-section-head">
                <h2>
                  {section.status === "ignored" ? "! " : ""}
                  {upper(title === sectionKey ? section.title : title)}
                </h2>
                <span>{section.items.length}</span>
              </header>
              {renderTable(section.items)}
            </section>
          );
        })
      )}
    </div>
  );
}
