"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type OperationsReason = "gmailSync" | "research" | "trackerDraft";

export type OperationsState = {
  gmailSync: boolean;
  research: boolean;
  trackerDraft: boolean;
  busy: boolean;
  reasons: OperationsReason[];
  /** True after first successful/failed fetch attempt. */
  ready: boolean;
};

const IDLE: Omit<OperationsState, "ready"> = {
  gmailSync: false,
  research: false,
  trackerDraft: false,
  busy: false,
  reasons: [],
};

type Ctx = {
  state: OperationsState;
  /** Ref-counted: connection is open only while at least one consumer is registered. */
  register: () => () => void;
};

const OperationsContext = createContext<Ctx | null>(null);

type StatusJson = {
  gmailSync?: boolean;
  research?: boolean;
  trackerDraft?: boolean;
  busy?: boolean;
  reasons?: OperationsReason[];
};

function parseStatus(data: StatusJson): Omit<OperationsState, "ready"> {
  const gmailSync = Boolean(data.gmailSync);
  const research = Boolean(data.research);
  const trackerDraft = Boolean(data.trackerDraft);
  const reasons = Array.isArray(data.reasons)
    ? data.reasons.filter(
        (r): r is OperationsReason =>
          r === "gmailSync" || r === "research" || r === "trackerDraft",
      )
    : [
        ...(gmailSync ? (["gmailSync"] as const) : []),
        ...(research ? (["research"] as const) : []),
        ...(trackerDraft ? (["trackerDraft"] as const) : []),
      ];
  return {
    gmailSync,
    research,
    trackerDraft,
    busy: Boolean(data.busy) || reasons.length > 0,
    reasons,
  };
}

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const FALLBACK_POLL_MS = 10000;
/** Failed attempts before we assume EventSource is unusable and poll slowly. */
const FALLBACK_AFTER_FAILURES = 3;

/**
 * Operations status over SSE (/api/operations/events). Connects only while a
 * consumer uses useOperations(). Reconnects with exponential backoff; slow
 * polling is used only when EventSource keeps failing. Server-side
 * settingsBusyResponse (409) remains the real guard.
 */
export function OperationsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OperationsState>({
    ...IDLE,
    ready: false,
  });
  const consumersRef = useRef(0);
  const stopRef = useRef<(() => void) | null>(null);

  const snapshot = useCallback(async () => {
    try {
      const res = await fetch("/api/operations/status", { cache: "no-store" });
      if (!res.ok) {
        setState((s) => ({ ...s, ready: true }));
        return;
      }
      const data = (await res.json()) as StatusJson;
      setState({ ...parseStatus(data), ready: true });
    } catch {
      setState((s) => ({ ...s, ready: true }));
    }
  }, []);

  const start = useCallback(() => {
    let disposed = false;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let failures = 0;
    let delay = BACKOFF_MIN_MS;

    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };

    const connect = () => {
      if (disposed || typeof EventSource === "undefined") {
        if (!disposed && !pollTimer) {
          pollTimer = setInterval(() => void snapshot(), FALLBACK_POLL_MS);
        }
        return;
      }
      es?.close();
      let source: EventSource;
      try {
        source = new EventSource("/api/operations/events");
      } catch {
        failures += 1;
        schedule();
        return;
      }
      es = source;

      source.onopen = () => {
        failures = 0;
        delay = BACKOFF_MIN_MS;
        stopPolling();
        // One snapshot on (re)connect covers anything missed while offline.
        void snapshot();
      };

      source.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as StatusJson & { type?: string };
          if (data.type === "snapshot" || data.type === "status") {
            setState({ ...parseStatus(data), ready: true });
          }
        } catch {
          /* ignore malformed frame */
        }
      };

      source.onerror = () => {
        source.close();
        if (es === source) es = null;
        failures += 1;
        schedule();
      };
    };

    const schedule = () => {
      if (disposed || retryTimer) return;
      if (failures >= FALLBACK_AFTER_FAILURES && !pollTimer) {
        pollTimer = setInterval(() => void snapshot(), FALLBACK_POLL_MS);
        void snapshot();
      }
      const wait = delay;
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, wait);
    };

    const onVisible = () => {
      if (document.visibilityState === "hidden") return;
      void snapshot();
      if (!es && !retryTimer) {
        delay = BACKOFF_MIN_MS;
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    void snapshot();
    connect();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      es?.close();
      es = null;
      if (retryTimer) clearTimeout(retryTimer);
      stopPolling();
    };
  }, [snapshot]);

  const register = useCallback(() => {
    consumersRef.current += 1;
    if (consumersRef.current === 1) stopRef.current = start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      consumersRef.current -= 1;
      if (consumersRef.current <= 0) {
        consumersRef.current = 0;
        stopRef.current?.();
        stopRef.current = null;
      }
    };
  }, [start]);

  useEffect(
    () => () => {
      stopRef.current?.();
      stopRef.current = null;
    },
    [],
  );

  const value = useMemo<Ctx>(() => ({ state, register }), [state, register]);

  return (
    <OperationsContext.Provider value={value}>
      {children}
    </OperationsContext.Provider>
  );
}

export function useOperations(): OperationsState {
  const ctx = useContext(OperationsContext);
  const register = ctx?.register;
  useEffect(() => {
    if (!register) return;
    return register();
  }, [register]);
  if (!ctx) {
    return { ...IDLE, ready: false };
  }
  return ctx.state;
}
