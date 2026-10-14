"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { SyncTerminal } from "@/components/SyncTerminal";
import { TruncateTip } from "@/components/TruncateTip";
import { Button } from "@/components/ui";
import type { SyncLogLine } from "@/lib/tracker/types";

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
};

type GmailModalState = {
  company: string;
  urls: string[];
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

type SortMode = "status" | "activity";

const SORT_STORAGE_KEY = "cmae.tracker.sort";
const SORT_EVENT = "cmae-tracker-sort";

function readSortMode(): SortMode {
  try {
    const v = localStorage.getItem(SORT_STORAGE_KEY);
    if (v === "activity" || v === "status") return v;
  } catch {
    /* ignore */
  }
  return "status";
}

function subscribeSortMode(onChange: () => void) {
  const handler = () => onChange();
  window.addEventListener("storage", handler);
  window.addEventListener(SORT_EVENT, handler);
  return () => {
    window.removeEventListener("storage", handler);
    window.removeEventListener(SORT_EVENT, handler);
  };
}

function writeSortMode(mode: SortMode) {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(SORT_EVENT));
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("tr-TR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

const STATUS_CHIP_LABEL: Record<string, string> = {
  ready_to_send: "Gönder",
  needs_reply: "Yanıt",
  needs_action: "Link / form",
  follow_up_due: "Follow-up",
  waiting: "Beklemede",
  in_progress: "Aktif",
  rejected: "Red",
  closed: "Kapalı",
  inactive: "Inactive",
  ignored: "Ignored",
};

function statusDetail(item: TrackerItem): string {
  if (item.status === "needs_reply" && item.sentiment) {
    return item.sentiment === "positive"
      ? "olumlu"
      : item.sentiment === "negative"
        ? "olumsuz"
        : "nötr";
  }
  if (item.status === "waiting" && item.waitingUntil) {
    try {
      return new Date(`${item.waitingUntil}T12:00:00`).toLocaleDateString(
        "tr-TR",
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
        return `fu ${new Date(unlock).toLocaleDateString("tr-TR", {
          day: "2-digit",
          month: "short",
        })}`;
      } catch {
        return "fu bekliyor";
      }
    }
  }
  if (item.status === "in_progress" && item.waitingOn) {
    return item.waitingOn === "us" ? "biz" : "onlar";
  }
  if (item.status === "follow_up_due" && item.followUpCount > 0) {
    return `${item.followUpCount}/2`;
  }
  return "";
}

export function TrackerList() {
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
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [syncSessionId, setSyncSessionId] = useState<string | null>(null);
  const syncEsRef = useRef<EventSource | null>(null);
  const liveEsRef = useRef<EventSource | null>(null);
  const syncShowToastRef = useRef(false);
  const sortMode = useSyncExternalStore(
    subscribeSortMode,
    readSortMode,
    () => "status" as SortMode,
  );

  const activityItems = useMemo(() => {
    const flat = sections.flatMap((s) => s.items);
    return [...flat].sort((a, b) => {
      const ta = a.lastActivityAt || "";
      const tb = b.lastActivityAt || "";
      return tb.localeCompare(ta);
    });
  }, [sections]);

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
      if (!res.ok) throw new Error(data.error || "Toplu işlem başarısız");
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
          ? `${data.updated ?? ids.length} başvuru pasife alındı`
          : `${data.updated ?? ids.length} başvuru aktif edildi — sonraki sync’te yeniden sınıflandırılır`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
    }
  }

  useEffect(() => {
    if (!gmailModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGmailModal(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gmailModal]);

  const load = useCallback(async () => {
    const res = await fetch("/api/tracker");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Liste yüklenemedi");
    setSections(data.sections || []);
    setSync(data.sync || null);
    setTotal(data.total || 0);
  }, []);

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
    }) => {
      setSections(data.sections || []);
      setSync(data.sync || null);
      setTotal(data.total || 0);
      if (data.showToast) {
        const parts = [
          data.mode === "hard" ? "Hard Sync" : "Sync",
          data.skippedImap
            ? `IMAP atlandı${data.skipReason ? `: ${data.skipReason}` : ""}`
            : `${data.upserted ?? 0} upsert`,
          `${data.itemCount ?? data.total ?? 0} satır`,
        ];
        if (
          typeof data.keptOutsideWindow === "number" &&
          data.keptOutsideWindow > 0
        ) {
          parts.push(`${data.keptOutsideWindow} eski korundu`);
        }
        setToast(parts.join(" · "));
      }
    },
    [],
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
        if (!res.ok) throw new Error(data.error || "Sync başlatılamadı");
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

    // Search light-merge → listeyi anında yenile (Gmail sync değil)
    const live = new EventSource("/api/tracker/live");
    liveEsRef.current = live;
    live.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as { type?: string };
        if (data.type === "search_merged" || data.type === "refresh") {
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

  async function prepare(item: TrackerItem, kind: "follow_up" | "thanks" | "reply") {
    const key = `${item.id}:prep:${kind}`;
    setBusyId(key);
    setError(null);
    try {
      const res = await fetch(`/api/tracker/${item.id}/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Hazırlama başarısız");
      setToast(`Taslak yazıldı: ${data.fileName}`);
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
    try {
      const res = await fetch(`/api/tracker/${item.id}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gmail taslağı oluşturulamadı");
      {
        const bits = [`Gmail Drafts’a yazıldı: ${data.subject}`];
        if (data.attachedCv) bits.push(`ek: ${data.attachedCv}`);
        if (data.cvWarning) bits.push(String(data.cvWarning));
        setToast(bits.join(" · "));
      }
      if (data.gmailUrl) window.open(data.gmailUrl, "_blank", "noopener,noreferrer");
      await load();
    } catch (err) {
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
        <a
          className="cmae-btn cmae-btn-ghost cmae-tracker-icon-btn"
          href={urls[0]}
          target="_blank"
          rel="noopener noreferrer"
          title="Gmail'de aç"
          aria-label="Gmail'de aç"
        >
          <IconGmail />
        </a>
      );
    }

    return (
      <Button
        type="button"
        variant="ghost"
        className="cmae-tracker-icon-btn"
        title={`Gmail'de aç (${urls.length} thread)`}
        aria-label={`Gmail'de aç, ${urls.length} thread`}
        onClick={() => setGmailModal({ company: item.company, urls })}
      >
        <IconGmail count={urls.length} />
      </Button>
    );
  }

  function renderPrimaryAction(item: TrackerItem) {
    if (item.status === "inactive") return null;

    const busy = busyId?.startsWith(`${item.id}:`);
    const spinning = Boolean(busy);

    if (item.status === "ready_to_send") {
      return (
        <Button
          type="button"
          className="cmae-tracker-icon-btn"
          disabled={spinning}
          title="Gmail taslağı oluştur"
          aria-label="Gmail taslağı oluştur"
          onClick={() => void draft(item, "application")}
        >
          {busyId === `${item.id}:draft:application` ? "…" : <IconDraft />}
        </Button>
      );
    }

    if (item.status === "follow_up_due") {
      if (!item.hasFollowUpDraft) {
        return (
          <Button
            type="button"
            variant="ghost"
            className="cmae-tracker-icon-btn"
            disabled={spinning}
            title="Follow-up hazırla"
            aria-label="Follow-up hazırla"
            onClick={() => void prepare(item, "follow_up")}
          >
            {busyId === `${item.id}:prep:follow_up` ? "…" : <IconPrepare />}
          </Button>
        );
      }
      return (
        <Button
          type="button"
          className="cmae-tracker-icon-btn"
          disabled={spinning}
          title="Follow-up Gmail taslağı"
          aria-label="Follow-up Gmail taslağı"
          onClick={() => void draft(item, "follow_up")}
        >
          {busyId === `${item.id}:draft:follow_up` ? "…" : <IconDraft />}
        </Button>
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
        return (
          <span
            className="cmae-tracker-icon-btn is-static"
            title="Dönüş tarihine kadar beklemede"
            aria-label="Beklemede"
          >
            <IconWait />
          </span>
        );
      }
      if (!item.hasReplyDraft) {
        return (
          <Button
            type="button"
            variant="ghost"
            className="cmae-tracker-icon-btn"
            disabled={spinning}
            title="Yanıt taslağı hazırla"
            aria-label="Yanıt taslağı hazırla"
            onClick={() => void prepare(item, "reply")}
          >
            {busyId === `${item.id}:prep:reply` ? "…" : <IconPrepare />}
          </Button>
        );
      }
      return (
        <Button
          type="button"
          className="cmae-tracker-icon-btn"
          disabled={spinning}
          title="Yanıt Gmail taslağı"
          aria-label="Yanıt Gmail taslağı"
          onClick={() => void draft(item, "reply")}
        >
          {busyId === `${item.id}:draft:reply` ? "…" : <IconDraft />}
        </Button>
      );
    }

    if (item.status === "rejected") {
      if (!item.hasThanksDraft) {
        return (
          <Button
            type="button"
            variant="ghost"
            className="cmae-tracker-icon-btn"
            disabled={spinning}
            title="Teşekkür hazırla"
            aria-label="Teşekkür hazırla"
            onClick={() => void prepare(item, "thanks")}
          >
            {busyId === `${item.id}:prep:thanks` ? "…" : <IconPrepare />}
          </Button>
        );
      }
      return (
        <Button
          type="button"
          className="cmae-tracker-icon-btn"
          disabled={spinning}
          title="Teşekkür Gmail taslağı"
          aria-label="Teşekkür Gmail taslağı"
          onClick={() => void draft(item, "thanks")}
        >
          {busyId === `${item.id}:draft:thanks` ? "…" : <IconDraft />}
        </Button>
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
    const label =
      STATUS_CHIP_LABEL[item.status] || item.status.replace(/_/g, " ");
    const detail = statusDetail(item);
    const tip = [item.statusLabel || label, detail].filter(Boolean).join(" · ");
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
            aria-label={`${item.company} seç`}
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
          <TruncateTip text={formatWhen(item.lastActivityAt)} />
        </span>
        <span className="cmae-tracker-muted" role="cell">
          <TruncateTip text={item.primaryTo || "—"} />
        </span>
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
            <span className="cmae-sr-only">Seç</span>
          </span>
          <span role="columnheader">Şirket</span>
          <span role="columnheader">Pozisyon</span>
          <span role="columnheader">Durum</span>
          <span role="columnheader">Son aktivite</span>
          <span role="columnheader">Alıcı</span>
          <span role="columnheader">Aksiyon</span>
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
        <div className="cmae-tracker-selbar" role="region" aria-label="Seçim çubuğu">
          <div className="cmae-tracker-selbar-inner">
            <span className="cmae-tracker-selbar-count">
              {selectedCount} seçili
            </span>
            <div className="cmae-tracker-selbar-actions">
              {selectedHasActive ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={bulkBusy}
                  onClick={() => void bulkSet("inactive")}
                >
                  Inactive et
                </Button>
              ) : null}
              {selectedHasInactive ? (
                <Button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => void bulkSet("active")}
                >
                  Aktif et
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                disabled={bulkBusy}
                onClick={() => setSelectedIds(new Set())}
              >
                Seçimi temizle
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {!loading && total > 0 ? (
        <div className="cmae-tracker-toolbar">
          <div className="cmae-tracker-meta">
            <span>{total} başvuru</span>
            <span className="cmae-tracker-dot">·</span>
            <span>
              Son sync:{" "}
              {sync?.lastSyncAt ? formatWhen(sync.lastSyncAt) : "henüz yok"}
            </span>
            {sync?.lastError ? (
              <>
                <span className="cmae-tracker-dot">·</span>
                <span className="cmae-tracker-err">{sync.lastError}</span>
              </>
            ) : null}
          </div>
          <div className="cmae-tracker-toolbar-right">
            <label className="cmae-tracker-sort">
              <span>Sırala</span>
              <select
                className="cmae-input cmae-tracker-sort-select"
                value={sortMode}
                onChange={(e) => writeSortMode(e.target.value as SortMode)}
                aria-label="Liste sıralaması"
              >
                <option value="status">Duruma göre (öncelik)</option>
                <option value="activity">Son aktiviteye göre</option>
              </select>
            </label>
            <Button
              type="button"
              variant="ghost"
              onClick={() => void runSync({ mode: "hard" })}
              disabled={syncing || loading}
              title="Son 30 günü baştan çeker; DB’deki eski mailler silinmez, messageId ile upsert"
            >
              Hard Sync
            </Button>
            <Button
              type="button"
              onClick={() => void runSync({ mode: "incremental" })}
              disabled={syncing || loading}
              title="Yalnızca yeni UID’leri çeker (hızlı)"
            >
              {syncing ? "Sync…" : "Gmail sync"}
            </Button>
          </div>
        </div>
      ) : null}

      {error ? <p className="cmae-tracker-banner is-error">{error}</p> : null}
      {toast ? <p className="cmae-tracker-banner">{toast}</p> : null}

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
                <h2 id="cmae-gmail-modal-title">Gmail thread’leri</h2>
                <p>
                  {gmailModal.company} — {gmailModal.urls.length} parçalı thread.
                  Normal tık yeni sekmeye geçer; burada kalmak için{" "}
                  <kbd className="cmae-kbd">Cmd</kbd>/
                  <kbd className="cmae-kbd">Ctrl</kbd>+tıkla.
                </p>
              </div>
              <button
                type="button"
                className="cmae-gmail-modal-close"
                onClick={() => setGmailModal(null)}
                aria-label="Kapat"
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
                  Thread {i + 1} — Gmail&apos;de aç
                </a>
              ))}
            </div>
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
        <p className="cmae-tracker-empty">Yükleniyor…</p>
      ) : total === 0 ? (
        <div className="cmae-tracker-empty cmae-tracker-empty-cta">
          <p>Henüz başvuru yok.</p>
          <p className="cmae-tracker-empty-hint">
            Gmail’i senkronize et veya Araştır ile şirket ekle.
          </p>
          <div className="cmae-tracker-empty-actions">
            <Button
              type="button"
              onClick={() => void runSync({ mode: "hard" })}
              disabled={syncing}
            >
              {syncing ? "Sync…" : "Gmail sync"}
            </Button>
          </div>
        </div>
      ) : sortMode === "activity" ? (
        <section className="cmae-tracker-section">
          <header className="cmae-tracker-section-head">
            <h2>Son aktivite</h2>
            <span>{activityItems.length}</span>
          </header>
          {renderTable(activityItems)}
        </section>
      ) : (
        sections.map((section) => (
          <section key={section.status} className="cmae-tracker-section">
            <header className="cmae-tracker-section-head">
              <h2>
                {section.status === "ignored" ? "! " : ""}
                {section.title}
              </h2>
              <span>{section.items.length}</span>
            </header>
            {renderTable(section.items)}
          </section>
        ))
      )}
    </div>
  );
}
