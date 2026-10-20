import { getSqlite } from "@/lib/db/client";
import { getSyncState } from "@/lib/tracker/sync";

export type FreshnessState =
  | "never_synced"
  | "fresh"
  | "syncing"
  | "stale_offline"
  | "auth_failed"
  | "partial"
  | "ai_degraded"
  | "throttled"
  | "account_switching"
  | "merge_pending"
  | "stale"
  | "unknown";

export type TrackerFreshness = {
  state: FreshnessState;
  dataAsOf: string | null;
  lastErrorKind: string | null;
  lastErrorMessage: string | null;
  activeIntervalMs: number;
  messageKey?: string;
  messageParams?: Record<string, string | number>;
};

const VISIBLE_INTERVAL_MS = 5 * 60_000;
const HIDDEN_INTERVAL_MS = 15 * 60_000;
const STALE_MULTIPLIER = 2;
const VERY_STALE_MS = 24 * 60 * 60_000;

declare global {
  // eslint-disable-next-line no-var
  var __cmaeSyncUiVisible: boolean | undefined;
}

export function setSyncUiVisible(visible: boolean): void {
  globalThis.__cmaeSyncUiVisible = visible;
}

export function isSyncUiVisible(): boolean {
  return globalThis.__cmaeSyncUiVisible !== false;
}

export function activeSyncIntervalMs(): number {
  return isSyncUiVisible() ? VISIBLE_INTERVAL_MS : HIDDEN_INTERVAL_MS;
}

function hasRunningMailJob(): boolean {
  try {
    const row = getSqlite()
      .prepare(
        `SELECT 1 AS ok FROM sync_jobs
         WHERE kind = 'mail_sync' AND state = 'running'
         LIMIT 1`,
      )
      .get() as { ok: number } | undefined;
    return Boolean(row?.ok);
  } catch {
    return false;
  }
}

function latestSucceededJobAt(): string | null {
  try {
    const row = getSqlite()
      .prepare(
        `SELECT finished_at AS finishedAt
         FROM sync_jobs
         WHERE kind = 'mail_sync' AND state IN ('succeeded', 'partial')
         ORDER BY finished_at DESC
         LIMIT 1`,
      )
      .get() as { finishedAt: string | null } | undefined;
    return row?.finishedAt ?? null;
  } catch {
    return null;
  }
}

function latestFailedJob(): {
  errorKind: string | null;
  errorMessage: string | null;
  finishedAt: string | null;
} | null {
  try {
    return (
      (getSqlite()
        .prepare(
          `SELECT error_kind AS errorKind, error_message AS errorMessage,
                  finished_at AS finishedAt
           FROM sync_jobs
           WHERE kind = 'mail_sync' AND state = 'failed'
           ORDER BY finished_at DESC
           LIMIT 1`,
        )
        .get() as {
        errorKind: string | null;
        errorMessage: string | null;
        finishedAt: string | null;
      } | undefined) ?? null
    );
  } catch {
    return null;
  }
}

function formatRelativeMinutes(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now.getTime() - t) / 60_000));
}

/**
 * Compute tracker freshness for GET / hello / UI banners.
 * Uses last successful job (or sync_state.lastSyncAt fallback) and recent failures.
 */
export function computeTrackerFreshness(now = new Date()): TrackerFreshness {
  const intervalMs = activeSyncIntervalMs();
  const sync = getSyncState();
  const dataAsOf = latestSucceededJobAt() || sync.lastSyncAt;
  const failed = latestFailedJob();

  if (hasRunningMailJob()) {
    return {
      state: "syncing",
      dataAsOf,
      lastErrorKind: null,
      lastErrorMessage: null,
      activeIntervalMs: intervalMs,
      messageKey: "tracker.freshness.syncing",
    };
  }

  if (!dataAsOf) {
    return {
      state: "never_synced",
      dataAsOf: null,
      lastErrorKind: failed?.errorKind ?? null,
      lastErrorMessage: failed?.errorMessage ?? sync.lastError,
      activeIntervalMs: intervalMs,
      messageKey: "tracker.freshness.neverSynced",
    };
  }

  if (
    failed?.errorKind === "auth" &&
    failed.finishedAt &&
    (!dataAsOf || Date.parse(failed.finishedAt) >= Date.parse(dataAsOf))
  ) {
    return {
      state: "auth_failed",
      dataAsOf,
      lastErrorKind: "auth",
      lastErrorMessage: failed.errorMessage,
      activeIntervalMs: intervalMs,
      messageKey: "tracker.freshness.authFailed",
    };
  }

  if (
    failed?.errorKind === "throttle" &&
    failed.finishedAt &&
    Date.parse(failed.finishedAt) >= Date.parse(dataAsOf)
  ) {
    return {
      state: "throttled",
      dataAsOf,
      lastErrorKind: "throttle",
      lastErrorMessage: failed.errorMessage,
      activeIntervalMs: intervalMs,
      messageKey: "tracker.freshness.throttled",
    };
  }

  if (
    failed?.errorKind === "network" &&
    failed.finishedAt &&
    Date.parse(failed.finishedAt) >= Date.parse(dataAsOf)
  ) {
    const mins = formatRelativeMinutes(dataAsOf, now);
    return {
      state: "stale_offline",
      dataAsOf,
      lastErrorKind: "network",
      lastErrorMessage: failed.errorMessage,
      activeIntervalMs: intervalMs,
      messageKey: "tracker.freshness.staleOffline",
      messageParams: {
        when: dataAsOf,
        minutes: mins ?? 0,
      },
    };
  }

  try {
    const last = getSqlite()
      .prepare(
        `SELECT state FROM sync_jobs
         WHERE kind = 'mail_sync' AND state IN ('succeeded','partial','failed')
         ORDER BY finished_at DESC LIMIT 1`,
      )
      .get() as { state: string } | undefined;
    if (last?.state === "partial") {
      return {
        state: "partial",
        dataAsOf,
        lastErrorKind: null,
        lastErrorMessage: sync.lastError,
        activeIntervalMs: intervalMs,
        messageKey: "tracker.freshness.partial",
      };
    }
  } catch {
    /* ignore */
  }

  const ageMs = now.getTime() - Date.parse(dataAsOf);
  const mins = formatRelativeMinutes(dataAsOf, now) ?? 0;

  // Faz 4: visible degrade when classify / unassigned / merge queues are non-empty.
  try {
    const db = getSqlite();
    const mergePending = db
      .prepare(
        `SELECT COUNT(*) AS n FROM merge_proposals WHERE state = 'pending'`,
      )
      .get() as { n: number } | undefined;
    if ((mergePending?.n || 0) > 0) {
      return {
        state: "merge_pending",
        dataAsOf,
        lastErrorKind: null,
        lastErrorMessage: null,
        activeIntervalMs: intervalMs,
        messageKey: "tracker.freshness.mergePending",
        messageParams: { count: mergePending!.n },
      };
    }
    const needsClass = db
      .prepare(
        `SELECT COUNT(*) AS n FROM mail_messages WHERE derive_state = 'needs_classification'`,
      )
      .get() as { n: number } | undefined;
    const unassigned = db
      .prepare(`SELECT COUNT(*) AS n FROM mail_unassigned`)
      .get() as { n: number } | undefined;
    const degraded = (needsClass?.n || 0) + (unassigned?.n || 0);
    if (degraded > 0) {
      return {
        state: "ai_degraded",
        dataAsOf,
        lastErrorKind: null,
        lastErrorMessage: null,
        activeIntervalMs: intervalMs,
        messageKey: "tracker.freshness.aiDegraded",
        messageParams: { count: degraded },
      };
    }
  } catch {
    /* tables may not exist mid-upgrade */
  }

  if (!Number.isFinite(ageMs) || ageMs > VERY_STALE_MS) {
    return {
      state: "stale",
      dataAsOf,
      lastErrorKind: null,
      lastErrorMessage: sync.lastError,
      activeIntervalMs: intervalMs,
      messageKey: "tracker.freshness.veryStale",
      messageParams: { minutes: mins },
    };
  }

  if (ageMs <= STALE_MULTIPLIER * intervalMs) {
    return {
      state: "fresh",
      dataAsOf,
      lastErrorKind: null,
      lastErrorMessage: null,
      activeIntervalMs: intervalMs,
      messageKey: "tracker.freshness.fresh",
      messageParams: { minutes: mins },
    };
  }

  return {
    state: "stale",
    dataAsOf,
    lastErrorKind: null,
    lastErrorMessage: sync.lastError,
    activeIntervalMs: intervalMs,
    messageKey: "tracker.freshness.stale",
    messageParams: { minutes: mins },
  };
}
