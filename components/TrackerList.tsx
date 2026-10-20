"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
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
import {
  applyTrackerListPayload,
  refreshTrackerList,
  useTrackerListSync,
} from "@/lib/tracker/client-store";
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

function IconHistory() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6a7 7 0 1 1 1.06 3.94l-1.42 1.42A9 9 0 1 0 13 3Zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12Z"
      />
    </svg>
  );
}

function IconMore() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="5" r="1.75" fill="currentColor" />
      <circle cx="12" cy="12" r="1.75" fill="currentColor" />
      <circle cx="12" cy="19" r="1.75" fill="currentColor" />
    </svg>
  );
}

function IconArchive() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M20.54 5.23 19.15 3.55A1.5 1.5 0 0 0 17.96 3H6.04c-.47 0-.92.22-1.19.55L3.46 5.23A1.5 1.5 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5c0-.47-.18-.92-.46-1.27ZM6.24 5h11.52l.81.97H5.43l.81-.97ZM12 17.5 8 13.5h2.5V10h3v3.5H16L12 17.5Z"
      />
    </svg>
  );
}

function IconUnarchive() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M20.54 5.23 19.15 3.55A1.5 1.5 0 0 0 17.96 3H6.04c-.47 0-.92.22-1.19.55L3.46 5.23A1.5 1.5 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5c0-.47-.18-.92-.46-1.27ZM6.24 5h11.52l.81.97H5.43l.81-.97ZM12 10l4 4h-2.5V17.5h-3V14H8l4-4Z"
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

type RecipientOption = {
  email: string;
  role: string | null;
  priority: number | null;
  reason: string | null;
  recommended: boolean;
};

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
    kind: "application" | "follow_up" | "thanks" | "reply";
    at: string;
    subject: string;
    draftsUrl?: string;
  } | null;
  recipientOptions?: RecipientOption[];
  recommendedTo?: string | null;
};

/** Open tab under the click gesture, then navigate after async work (avoids popup block).
 * Do not use noopener — we need the Window handle to set location after fetch.
 * Desktop: skip about:blank — Electron routes window.open to shell.openExternal,
 * and Windows cannot open the about: protocol. */
function openTabForAsyncUrl(): Window | null {
  if (window.cmaeDesktop?.isDesktop) return null;
  try {
    return window.open("about:blank", "_blank");
  } catch {
    return null;
  }
}

async function navigateOpenedTab(
  popup: Window | null,
  url: string | null | undefined,
): Promise<boolean> {
  if (!url) {
    popup?.close();
    return false;
  }
  if (window.cmaeDesktop?.openExternal) {
    popup?.close();
    try {
      const result = await window.cmaeDesktop.openExternal(url);
      return result.ok;
    } catch {
      return false;
    }
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
  const router = useRouter();
  const t = useT();
  const upper = useLocaleUpper();
  const locale = useIntlLocale();
  const store = useTrackerListSync();
  const sections = (store.sections || []) as Section[];
  const sync = store.sync as SyncMeta | null;
  const total = store.total;
  const loading = store.loading;
  const [syncing, setSyncing] = useState(false);
  const [syncLines, setSyncLines] = useState<SyncLogLine[]>([]);
  const [syncTermStatus, setSyncTermStatus] = useState<SyncTermStatus | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  /** Per-row busy keys (itemId:op) — multiple rows can be busy at once. */
  const [busyKeys, setBusyKeys] = useState<Set<string>>(() => new Set());

  function addBusyKey(key: string) {
    setBusyKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }

  function removeBusyKey(key: string) {
    setBusyKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }

  function isBusyKey(key: string): boolean {
    return busyKeys.has(key);
  }

  function isBusyItem(itemId: number): boolean {
    const prefix = `${itemId}:`;
    for (const k of busyKeys) {
      if (k.startsWith(prefix)) return true;
    }
    return false;
  }

  function isBusyItemPrefix(itemId: number, prefix: string): boolean {
    const full = `${itemId}:${prefix}`;
    for (const k of busyKeys) {
      if (k.startsWith(full)) return true;
    }
    return false;
  }
  const [toast, setToast] = useState<string | null>(null);
  const [gmailModal, setGmailModal] = useState<GmailModalState | null>(null);
  const [prepareModal, setPrepareModal] = useState<PrepareModalState | null>(
    null,
  );
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [syncSessionId, setSyncSessionId] = useState<string | null>(null);
  const [hardSync, setHardSync] = useState(false);
  const [actionsMenuId, setActionsMenuId] = useState<number | null>(null);
  const syncEsRef = useRef<EventSource | null>(null);
  const syncShowToastRef = useRef(false);

  useEffect(() => {
    if (store.error) setError(store.error);
  }, [store.error]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 15_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (actionsMenuId == null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setActionsMenuId(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actionsMenuId]);

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

  async function applyActiveAction(
    ids: number[],
    action: "inactive" | "active",
    opts?: { clearSelection?: boolean },
  ) {
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
        applyTrackerListPayload({
          sections: data.sections,
          sync: data.sync || null,
          total: data.total || 0,
          rev: typeof data.rev === "number" ? data.rev : undefined,
        });
      } else {
        await refreshTrackerList({ force: true });
      }
      if (opts?.clearSelection) setSelectedIds(new Set());
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

  async function bulkSet(action: "inactive" | "active") {
    await applyActiveAction([...selectedIds], action, { clearSelection: true });
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
    await refreshTrackerList({ force: true });
  }, []);

  const pendingDraftCount = useMemo(
    () => allItems.filter((i) => Boolean(i.pendingGmailDraft)).length,
    [allItems],
  );

  const applySyncPayload = useCallback(
    (data: {
      sections?: Section[];
      sync?: SyncMeta;
      total?: number;
      rev?: number;
      skippedImap?: boolean;
      skipReason?: string;
      upserted?: number;
      itemCount?: number;
      showToast?: boolean;
      mode?: "incremental" | "hard";
      keptOutsideWindow?: number;
    }) => {
      applyTrackerListPayload({
        sections: data.sections || [],
        sync: data.sync || null,
        total: data.total || 0,
        rev: data.rev,
      });
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
        // List load + SSE come from useTrackerListSync; only join running sync here.
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
      }
    })();

    return () => {
      cancelled = true;
      // Only detach UI stream — do NOT cancel the server sync
      detachSyncStream();
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

  function patchItemRecipient(
    itemId: number,
    primaryTo: string,
    recipientOptions?: RecipientOption[],
    recommendedTo?: string | null,
  ) {
    const nextSections = sections.map((sec) => ({
      ...sec,
      items: sec.items.map((it) =>
        it.id === itemId
          ? {
              ...it,
              primaryTo,
              ...(recipientOptions ? { recipientOptions } : {}),
              ...(recommendedTo !== undefined ? { recommendedTo } : {}),
            }
          : it,
      ),
    }));
    applyTrackerListPayload({
      sections: nextSections,
      sync,
      total,
      rev: store.rev,
    });
  }

  async function changeRecipient(item: TrackerItem, email: string) {
    if (!email || email === item.primaryTo) return;
    const key = `${item.id}:recipient`;
    addBusyKey(key);
    setError(null);
    try {
      const res = await fetch(`/api/tracker/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ primaryTo: email }),
      });
      const data = (await res.json()) as {
        error?: string;
        primaryTo?: string;
        recipientOptions?: RecipientOption[];
        recommendedTo?: string | null;
      };
      if (!res.ok) throw new Error(data.error || t("tracker.error.loadList"));
      const next = data.primaryTo || email;
      patchItemRecipient(
        item.id,
        next,
        data.recipientOptions,
        data.recommendedTo,
      );
      setToast(t("tracker.recipient.saved", { email: next }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      removeBusyKey(key);
    }
  }

  function recipientOptionLabel(opt: RecipientOption): string {
    const base = opt.role
      ? t("tracker.recipient.optionWithRole", {
          email: opt.email,
          role: opt.role,
        })
      : t("tracker.recipient.option", { email: opt.email });
    return opt.recommended
      ? t("tracker.recipient.optionRecommended", { label: base })
      : base;
  }

  function renderRecipientCell(item: TrackerItem) {
    const options = item.recipientOptions || [];
    if (options.length > 1) {
      const value =
        item.primaryTo &&
        options.some(
          (o) => o.email.toLowerCase() === item.primaryTo!.toLowerCase(),
        )
          ? options.find(
              (o) => o.email.toLowerCase() === item.primaryTo!.toLowerCase(),
            )!.email
          : options.find((o) => o.recommended)?.email ||
            options[0]?.email ||
            "";
      const selected = options.find(
        (o) => o.email.toLowerCase() === value.toLowerCase(),
      );
      const tipParts = [
        selected?.reason,
        selected?.recommended
          ? t("tracker.recipient.recommended")
          : null,
      ].filter(Boolean);
      const tipLabel = tipParts.join(" · ");
      return (
        <span className="cmae-tracker-recipient" role="cell">
          <HoverTip label={tipLabel} className="is-fill">
            <select
              className="cmae-tracker-recipient-select"
              value={value}
              disabled={isBusyKey(`${item.id}:recipient`)}
              aria-label={t("tracker.recipient.aria", {
                company: item.company,
              })}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                void changeRecipient(item, e.target.value);
              }}
            >
              {options.map((opt) => (
                <option key={opt.email} value={opt.email}>
                  {recipientOptionLabel(opt)}
                </option>
              ))}
            </select>
          </HoverTip>
        </span>
      );
    }
    return (
      <span className="cmae-tracker-muted" role="cell">
        <TruncateTip text={item.primaryTo || "—"} />
      </span>
    );
  }

  async function prepare(
    item: TrackerItem,
    kind: DraftPrepareKind,
    variant: DraftVariantId,
    userNote: string,
    eventKinds: string[],
  ) {
    const key = `${item.id}:prep:${kind}`;
    addBusyKey(key);
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
      removeBusyKey(key);
    }
  }

  async function draft(
    item: TrackerItem,
    kind: "application" | "follow_up" | "thanks" | "reply",
  ) {
    const key = `${item.id}:draft:${kind}`;
    addBusyKey(key);
    setError(null);
    try {
      const res = await fetch(`/api/tracker/${item.id}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("tracker.error.gmailDraft"));
      // Stay in Tracker — Gmail opens only when the user clicks the clock.
      const bits = [
        t("tracker.toast.gmailDraftPending", { subject: data.subject }),
      ];
      if (data.attachedCv) {
        bits.push(t("tracker.toast.attachment", { name: data.attachedCv }));
      }
      if (data.cvWarning) bits.push(String(data.cvWarning));
      setToast(bits.join(" · "));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      removeBusyKey(key);
    }
  }

  /** Pending clock: open Gmail Drafts; recreate from .md if the draft was deleted. */
  async function openPendingDraft(item: TrackerItem) {
    const pending = item.pendingGmailDraft;
    if (!pending) return;
    const key = `${item.id}:draft:${pending.kind}`;
    addBusyKey(key);
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
      const opened = await navigateOpenedTab(popup, url);
      if (!opened && url) {
        setToast(t("tracker.pendingDraft.popupBlocked"));
      }
      await load();
    } catch (err) {
      popup?.close();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      removeBusyKey(key);
    }
  }

  function closeActionsMenu() {
    setActionsMenuId(null);
  }

  function renderMenuItem(opts: {
    label: string;
    icon: ReactNode;
    disabled?: boolean;
    href?: string;
    onClick?: () => void;
  }) {
    const className = "cmae-tracker-actions-menu-item";
    if (opts.href) {
      return (
        <a
          role="menuitem"
          className={className}
          href={opts.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            e.stopPropagation();
            closeActionsMenu();
          }}
        >
          <span className="cmae-tracker-actions-menu-ico" aria-hidden>
            {opts.icon}
          </span>
          <span>{opts.label}</span>
        </a>
      );
    }
    return (
      <button
        type="button"
        role="menuitem"
        className={className}
        disabled={opts.disabled}
        onClick={(e) => {
          e.stopPropagation();
          closeActionsMenu();
          opts.onClick?.();
        }}
      >
        <span className="cmae-tracker-actions-menu-ico" aria-hidden>
          {opts.icon}
        </span>
        <span>{opts.label}</span>
      </button>
    );
  }

  function renderGmailMenuItem(item: TrackerItem) {
    const urls = [...new Set((item.gmailUrls || []).filter(Boolean))];
    if (!urls.length) return null;

    if (urls.length === 1) {
      return renderMenuItem({
        label: t("tracker.action.openGmail"),
        icon: <IconGmail />,
        href: urls[0],
      });
    }

    return renderMenuItem({
      label: t("tracker.action.openGmailN", { count: urls.length }),
      icon: <IconGmail count={urls.length} />,
      onClick: () => setGmailModal({ company: item.company, urls }),
    });
  }

  function renderPrimaryMenuItem(item: TrackerItem) {
    if (item.status === "inactive") return null;

    const spinning = isBusyItem(item.id);

    if (item.pendingGmailDraft) {
      return renderMenuItem({
        label: t("tracker.action.pendingSend"),
        icon: isBusyKey(
          `${item.id}:draft:${item.pendingGmailDraft.kind}`,
        ) ? (
          <IconSpinner />
        ) : (
          <IconWait />
        ),
        disabled: spinning,
        onClick: () => void openPendingDraft(item),
      });
    }

    if (item.status === "ready_to_send") {
      return renderMenuItem({
        label: t("tracker.action.createDraft"),
        icon: isBusyKey(`${item.id}:draft:application`) ? (
          <IconSpinner />
        ) : (
          <IconDraft />
        ),
        disabled: spinning,
        onClick: () => void draft(item, "application"),
      });
    }

    if (item.status === "follow_up_due") {
      if (!item.hasFollowUpDraft) {
        return renderMenuItem({
          label: t("tracker.action.prepareFollowUp"),
          icon: isBusyKey(`${item.id}:prep:follow_up`) ? (
            <IconSpinner />
          ) : (
            <IconPrepare />
          ),
          disabled: spinning,
          onClick: () => openPrepareModal(item, "follow_up"),
        });
      }
      return renderMenuItem({
        label: t("tracker.action.draftFollowUp"),
        icon: isBusyKey(`${item.id}:draft:follow_up`) ? (
          <IconSpinner />
        ) : (
          <IconDraft />
        ),
        disabled: spinning,
        onClick: () => void draft(item, "follow_up"),
      });
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
        return null;
      }
      if (!item.hasReplyDraft) {
        return renderMenuItem({
          label: t("tracker.action.prepareReply"),
          icon: isBusyKey(`${item.id}:prep:reply`) ? (
            <IconSpinner />
          ) : (
            <IconPrepare />
          ),
          disabled: spinning,
          onClick: () => openPrepareModal(item, "reply"),
        });
      }
      return renderMenuItem({
        label: t("tracker.action.draftReply"),
        icon: isBusyKey(`${item.id}:draft:reply`) ? (
          <IconSpinner />
        ) : (
          <IconDraft />
        ),
        disabled: spinning,
        onClick: () => void draft(item, "reply"),
      });
    }

    if (item.status === "rejected") {
      if (!item.hasThanksDraft) {
        return renderMenuItem({
          label: t("tracker.action.prepareThanks"),
          icon: isBusyKey(`${item.id}:prep:thanks`) ? (
            <IconSpinner />
          ) : (
            <IconPrepare />
          ),
          disabled: spinning,
          onClick: () => openPrepareModal(item, "thanks"),
        });
      }
      return renderMenuItem({
        label: t("tracker.action.draftThanks"),
        icon: isBusyKey(`${item.id}:draft:thanks`) ? (
          <IconSpinner />
        ) : (
          <IconDraft />
        ),
        disabled: spinning,
        onClick: () => void draft(item, "thanks"),
      });
    }

    return null;
  }

  function renderHistoryAction(item: TrackerItem) {
    // ready_to_send: no mail history yet — timeline page has little to show
    if (item.status === "ready_to_send") return null;
    const label = t("tracker.action.openHistory", { company: item.company });
    return (
      <HoverTip label={label}>
        <Button
          type="button"
          variant="ghost"
          className="cmae-tracker-icon-btn"
          aria-label={label}
          onClick={() => {
            closeActionsMenu();
            router.push(`/tracker/${item.id}`);
          }}
        >
          <IconHistory />
        </Button>
      </HoverTip>
    );
  }

  function renderWaitingIndicator(item: TrackerItem) {
    if (item.status !== "waiting" || item.pendingGmailDraft) return null;
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

  function renderActiveToggleMenuItem(item: TrackerItem) {
    const isInactive = item.status === "inactive";
    const action = isInactive ? "active" : "inactive";
    return renderMenuItem({
      label: isInactive
        ? t("tracker.sel.markActive")
        : t("tracker.sel.markInactive"),
      icon: isInactive ? <IconUnarchive /> : <IconArchive />,
      disabled: bulkBusy,
      onClick: () => void applyActiveAction([item.id], action),
    });
  }

  function renderActionsMenu(item: TrackerItem) {
    const gmailItem = renderGmailMenuItem(item);
    const primaryItem = renderPrimaryMenuItem(item);
    const activeToggle = renderActiveToggleMenuItem(item);
    const hasPrimaryActions = Boolean(gmailItem || primaryItem);

    const open = actionsMenuId === item.id;
    const moreLabel = t("tracker.action.more");

    return (
      <span className="cmae-tracker-actions-menu-wrap">
        {open ? (
          <>
            <div
              className="cmae-tracker-actions-menu-backdrop"
              aria-hidden
              onClick={(e) => {
                e.stopPropagation();
                closeActionsMenu();
              }}
            />
            <div
              className="cmae-tracker-actions-menu"
              role="menu"
              aria-label={moreLabel}
            >
              {gmailItem}
              {primaryItem}
              {hasPrimaryActions ? (
                <div
                  className="cmae-tracker-actions-menu-sep"
                  role="separator"
                />
              ) : null}
              {activeToggle}
            </div>
          </>
        ) : null}
        <HoverTip label={moreLabel}>
          <Button
            type="button"
            variant="ghost"
            className="cmae-tracker-icon-btn"
            aria-label={moreLabel}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation();
              setActionsMenuId(open ? null : item.id);
            }}
          >
            <IconMore />
          </Button>
        </HoverTip>
      </span>
    );
  }

  function renderActions(item: TrackerItem) {
    const historyBtn = renderHistoryAction(item);
    const waiting = renderWaitingIndicator(item);
    const menu = renderActionsMenu(item);
    if (!historyBtn && !waiting && !menu) {
      return <span className="cmae-tracker-action-empty">—</span>;
    }
    return (
      <>
        {historyBtn}
        {waiting}
        {menu}
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
        className={`cmae-tracker-row${item.status === "ignored" ? " is-ignored" : ""}${checked ? " is-selected" : ""}${item.status === "inactive" ? " is-inactive" : ""}`}
        role="row"
      >
        <span className="cmae-tracker-check" role="cell">
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
        <span className="cmae-tracker-status-cell" role="cell">
          <HoverTip label={tip} className="is-fill">
            <span
              className="cmae-status-chip"
              data-status={item.status}
            >
              <span className="cmae-status-chip-label">{label}</span>
              {detail ? (
                <>
                  <span className="cmae-status-chip-sep" aria-hidden />
                  <span className="cmae-status-chip-meta">{detail}</span>
                </>
              ) : null}
            </span>
          </HoverTip>
        </span>
        <span className="cmae-tracker-muted" role="cell">
          <TruncateTip text={formatWhen(item.lastActivityAt, locale)} />
        </span>
        {renderRecipientCell(item)}
        <span className="cmae-tracker-actions" role="cell">
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
                <HoverTip label={t("tracker.hardSyncTitle")}>
                  <button
                    type="button"
                    role="switch"
                    className={`cmae-tracker-switch-btn${hardSync ? " is-on" : ""}`}
                    aria-checked={hardSync}
                    aria-label={t("tracker.hardSyncToggle")}
                    disabled={syncing || loading}
                    onClick={() => setHardSync((v) => !v)}
                  >
                    <span className="cmae-tracker-switch-knob" aria-hidden />
                  </button>
                </HoverTip>
                <div className="cmae-tracker-hard-sync-text">
                  <span className="cmae-tracker-hard-sync-label">
                    {t("tracker.hardSyncToggle")}
                  </span>
                  <span className="cmae-tracker-hard-sync-hint">
                    {t("tracker.hardSyncHint")}
                  </span>
                </div>
              </div>
              <HoverTip
                label={
                  hardSync ? t("tracker.hardSyncTitle") : t("tracker.syncTitle")
                }
              >
                <Button
                  type="button"
                  className="cmae-tracker-icon-btn"
                  onClick={() => {
                    const mode = hardSync ? "hard" : "incremental";
                    setHardSync(false);
                    void runSync({ mode });
                  }}
                  disabled={syncing || loading}
                  aria-label={
                    hardSync ? t("tracker.hardSync") : t("tracker.sync")
                  }
                >
                  {syncing ? <IconSpinner /> : <IconSync />}
                </Button>
              </HoverTip>
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
              <>
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
                </div>
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
                    disabled={isBusyItemPrefix(
                      prepareModal.item.id,
                      "prep:",
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
                    {isBusyItemPrefix(prepareModal.item.id, "prep:")
                      ? t("tracker.variantNote.preparing")
                      : t("tracker.variantNote.prepare")}
                  </Button>
                </div>
              </>
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
            <HoverTip label={t("tracker.syncTitle")}>
              <Button
                type="button"
                onClick={() => void runSync({ mode: "incremental" })}
                disabled={syncing}
              >
                {syncing ? t("tracker.syncing") : t("tracker.sync")}
              </Button>
            </HoverTip>
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
