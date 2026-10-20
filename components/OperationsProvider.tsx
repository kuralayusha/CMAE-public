"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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

const OperationsContext = createContext<OperationsState | null>(null);

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

/**
 * App-wide poll of GET /api/operations/status so Settings (and others) can
 * lock while Gmail sync, research, or draft prepare/create is running —
 * including when the user stays on Settings until the op finishes.
 */
export function OperationsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OperationsState>({
    ...IDLE,
    ready: false,
  });

  const refresh = useCallback(async () => {
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const ms = state.busy ? 2000 : 4000;
    const t = setInterval(() => void refresh(), ms);
    return () => clearInterval(t);
  }, [refresh, state.busy]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "hidden") return;
      void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refresh]);

  const value = useMemo(() => state, [state]);

  return (
    <OperationsContext.Provider value={value}>
      {children}
    </OperationsContext.Provider>
  );
}

export function useOperations(): OperationsState {
  const ctx = useContext(OperationsContext);
  if (!ctx) {
    return { ...IDLE, ready: false };
  }
  return ctx;
}
