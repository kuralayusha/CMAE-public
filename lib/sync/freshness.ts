import { getSqlite } from "@/lib/db/client";
import { drainAmbiguousRoutingSkips } from "@/lib/tracker/derive/assign";
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

function latestSucceededJobAt(kind: string): string | null {
  try {
    const row = getSqlite()
      .prepare(
        `SELECT finished_at AS finishedAt
         FROM sync_jobs
         WHERE kind = ? AND state IN ('succeeded', 'partial')
         ORDER BY finished_at DESC
         LIMIT 1`,
      )
      .get(kind) as { finishedAt: string | null } | undefined;
    return row?.finishedAt ?? null;
  } catch {
    return null;
  }
}

/** dataAsOf = oldest of last full-success mail + drafts jobs (when drafts pending). */
function computeDataAsOf(syncLast: string | null): string | null {
  const mailAt = latestSucceededJobAt("mail_sync") || syncLast;
  let draftsAt: string | null = null;
  try {
    const live = getSqlite()
      .prepare(
        `SELECT COUNT(*) AS n FROM gmail_drafts
         WHERE state IN ('creating','present','unknown')`,
      )
      .get() as { n: number } | undefined;
    if ((live?.n || 0) > 0) {
      draftsAt = latestSucceededJobAt("drafts_reconcile");
    }
  } catch {
    /* table may not exist mid-upgrade */
  }
  if (!mailAt) return draftsAt;
  if (!draftsAt) return mailAt;
  return Date.parse(mailAt) <= Date.parse(draftsAt) ? mailAt : draftsAt;
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
  const dataAsOf = computeDataAsOf(sync.lastSyncAt);
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

  // Faz 4: visible degrade when classify / unassigned queues are non-empty.
  // Pending merges are a dedicated Manage banner on Tracker — not a freshness state.
  try {
    // Lazy repair: AI skips must not sit in mail_unassigned forever (banner lie).
    try {
      drainAmbiguousRoutingSkips();
    } catch {
      /* ignore mid-upgrade / locked */
    }
    const db = getSqlite();
    const needsClass = db
      .prepare(
        `SELECT COUNT(*) AS n FROM mail_messages WHERE derive_state = 'needs_classification'`,
      )
      .get() as { n: number } | undefined;
    const unmatched = db
      .prepare(
        `SELECT COUNT(*) AS n FROM mail_unassigned WHERE reason = 'unmatched_outbound'`,
      )
      .get() as { n: number } | undefined;
    const aiUnavail = db
      .prepare(
        `SELECT COUNT(*) AS n FROM mail_unassigned WHERE reason = 'ai_unavailable'`,
      )
      .get() as { n: number } | undefined;
    const otherUnassigned = db
      .prepare(
        `SELECT COUNT(*) AS n FROM mail_unassigned
         WHERE reason NOT IN ('unmatched_outbound', 'ai_unavailable')`,
      )
      .get() as { n: number } | undefined;
    const needs = needsClass?.n || 0;
    const unmatchedN = unmatched?.n || 0;
    const aiUnavailN = aiUnavail?.n || 0;
    const otherN = otherUnassigned?.n || 0;
    const unassignedN = unmatchedN + aiUnavailN + otherN;
    const degraded = needs + unassignedN;
    if (degraded > 0) {
      let messageKey = "tracker.freshness.aiDegraded";
      let count = degraded;
      if (needs === 0 && unmatchedN > 0 && aiUnavailN === 0 && otherN === 0) {
        // Honest UX for unmatched sent (architecture §2.6.1) — not "temporary".
        messageKey = "tracker.freshness.unmatchedOutbound";
        count = unmatchedN;
      } else if (needs === 0 && aiUnavailN > 0 && unmatchedN === 0 && otherN === 0) {
        messageKey = "tracker.freshness.aiUnavailable";
        count = aiUnavailN;
      } else if (needs === 0 && unassignedN > 0) {
        messageKey = "tracker.freshness.unassignedPending";
        count = unassignedN;
      } else if (needs > 0 && unassignedN > 0) {
        messageKey = "tracker.freshness.aiDegradedAndUnassigned";
        count = degraded;
      }
      return {
        state: "ai_degraded",
        dataAsOf,
        lastErrorKind: null,
        lastErrorMessage: null,
        activeIntervalMs: intervalMs,
        messageKey,
        messageParams: {
          count,
          classCount: needs,
          unassignedCount: unassignedN,
        },
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
