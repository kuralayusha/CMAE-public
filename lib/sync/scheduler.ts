import { getSqlite } from "@/lib/db/client";
import { isOnboardingComplete } from "@/lib/onboarding/status";
import {
  enqueueDraftsReconcile,
  enqueueWorkspaceScan,
  hasPendingDraftsReconcile,
  isAutoSyncBlockedByAuth,
  recoverInterruptedJobs,
  requestSync,
} from "./engine";
import { activeSyncIntervalMs } from "./freshness";

const STARTUP_DELAY_MS = 2_000;
const DRAFTS_RECONCILE_INTERVAL_MS = 2 * 60_000;
const WORKSPACE_SCAN_INTERVAL_MS = 10 * 60_000;

declare global {
  // eslint-disable-next-line no-var
  var __cmaeSyncScheduler: {
    started: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    expectedAt: number | null;
    lastTickAt: number | null;
    draftsTimer: ReturnType<typeof setTimeout> | null;
    workspaceTimer: ReturnType<typeof setTimeout> | null;
  } | undefined;
}

function state() {
  if (!globalThis.__cmaeSyncScheduler) {
    globalThis.__cmaeSyncScheduler = {
      started: false,
      timer: null,
      expectedAt: null,
      lastTickAt: null,
      draftsTimer: null,
      workspaceTimer: null,
    };
  }
  return globalThis.__cmaeSyncScheduler;
}

function scheduleDraftsReconcileTick() {
  const s = state();
  if (s.draftsTimer) {
    clearTimeout(s.draftsTimer);
    s.draftsTimer = null;
  }
  if (!hasPendingDraftsReconcile()) return;
  if (isAutoSyncBlockedByAuth()) return;
  s.draftsTimer = setTimeout(() => {
    s.draftsTimer = null;
    if (isOnboardingComplete() && !isAutoSyncBlockedByAuth()) {
      if (hasPendingDraftsReconcile()) {
        enqueueDraftsReconcile("interval");
      }
    }
    scheduleDraftsReconcileTick();
  }, DRAFTS_RECONCILE_INTERVAL_MS);
  if (typeof s.draftsTimer === "object" && s.draftsTimer && "unref" in s.draftsTimer) {
    s.draftsTimer.unref();
  }
}

function scheduleWorkspaceScanTick() {
  const s = state();
  if (s.workspaceTimer) {
    clearTimeout(s.workspaceTimer);
    s.workspaceTimer = null;
  }
  s.workspaceTimer = setTimeout(() => {
    s.workspaceTimer = null;
    if (isOnboardingComplete()) {
      enqueueWorkspaceScan("interval");
    }
    scheduleWorkspaceScanTick();
  }, WORKSPACE_SCAN_INTERVAL_MS);
  if (
    typeof s.workspaceTimer === "object" &&
    s.workspaceTimer &&
    "unref" in s.workspaceTimer
  ) {
    s.workspaceTimer.unref();
  }
}

function jitter(ms: number): number {
  const factor = 0.9 + Math.random() * 0.2; // ±10%
  return Math.max(5_000, Math.round(ms * factor));
}

function lastSuccessAtMs(): number | null {
  try {
    const row = getSqlite()
      .prepare(
        `SELECT finished_at AS finishedAt FROM sync_jobs
         WHERE kind = 'mail_sync' AND state IN ('succeeded','partial')
         ORDER BY finished_at DESC LIMIT 1`,
      )
      .get() as { finishedAt: string } | undefined;
    if (!row?.finishedAt) {
      const sync = getSqlite()
        .prepare(`SELECT last_sync_at AS lastSyncAt FROM sync_state WHERE id = 1`)
        .get() as { lastSyncAt: string | null } | undefined;
      if (!sync?.lastSyncAt) return null;
      const t = Date.parse(sync.lastSyncAt);
      return Number.isFinite(t) ? t : null;
    }
    const t = Date.parse(row.finishedAt);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

function clearTimer() {
  const s = state();
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  s.expectedAt = null;
}

function scheduleNext(reason: "interval" | "startup" = "interval") {
  const s = state();
  clearTimer();

  if (isAutoSyncBlockedByAuth()) return;

  const interval = activeSyncIntervalMs();
  const last = lastSuccessAtMs();
  const now = Date.now();
  let delay: number;

  if (reason === "startup") {
    delay = STARTUP_DELAY_MS;
  } else if (last == null) {
    delay = STARTUP_DELAY_MS;
  } else {
    const due = last + interval;
    delay = Math.max(5_000, due - now);
  }

  delay = jitter(delay);
  s.expectedAt = now + delay;
  s.lastTickAt = now;
  s.timer = setTimeout(() => {
    onTick();
  }, delay);
  if (typeof s.timer === "object" && s.timer && "unref" in s.timer) {
    s.timer.unref();
  }
}

function onTick() {
  const s = state();
  const now = Date.now();
  const expected = s.expectedAt;
  s.timer = null;
  s.expectedAt = null;

  // Wall-clock drift: slept longer than 2× interval → treat as resume.
  const interval = activeSyncIntervalMs();
  let reason: "interval" | "resume" = "interval";
  if (expected != null && now - expected > 2 * interval) {
    reason = "resume";
  }

  if (isOnboardingComplete() && !isAutoSyncBlockedByAuth()) {
    requestSync({ reason, mode: "incremental" });
    if (reason === "resume") {
      void import("@/lib/mail/idle-watcher").then((idle) => {
        idle.reconnectIdleWatcher();
      });
    }
  }

  scheduleNext("interval");
  scheduleDraftsReconcileTick();
}

/** Resume / unlock / online wake from Electron or drift. */
export function wakeScheduler(opts?: {
  reason?: "resume" | "unlock" | "online" | "focus" | "wake";
}): void {
  if (!isOnboardingComplete()) return;
  if (isAutoSyncBlockedByAuth()) return;

  const reason =
    opts?.reason === "focus" || opts?.reason === "online"
      ? opts.reason
      : opts?.reason === "unlock"
        ? "resume"
        : opts?.reason === "resume"
          ? "resume"
          : "wake";

  requestSync({ reason, mode: "incremental" });
  scheduleNext("interval");
  scheduleDraftsReconcileTick();
  void import("@/lib/mail/idle-watcher").then((idle) => {
    idle.reconnectIdleWatcher();
  });
}

export function rescheduleAfterVisibilityChange(): void {
  if (!state().started) return;
  scheduleNext("interval");
  scheduleDraftsReconcileTick();
}

export function onCredentialsVersionChanged(): void {
  scheduleNext("interval");
  if (isOnboardingComplete() && !isAutoSyncBlockedByAuth()) {
    requestSync({ reason: "wake", mode: "incremental" });
    void import("@/lib/mail/idle-watcher").then((idle) => {
      idle.reconnectIdleWatcher();
    });
  } else {
    void import("@/lib/mail/idle-watcher").then((idle) => {
      idle.stopIdleWatcher();
    });
  }
}

/**
 * Start the sync scheduler once per process (HMR-safe via globalThis).
 * Must be non-blocking from instrumentation.register().
 */
export function start(): void {
  const s = state();
  if (s.started) return;
  s.started = true;

  try {
    // Ensure DB/migrations are ready before recovering jobs.
    getSqlite();
    recoverInterruptedJobs();
    void import("@/lib/tracker/account-switch").then((m) => {
      m.completeOrphanAccountWipe();
      m.pruneAccountSwitchBackups();
    });
  } catch (err) {
    console.error("[sync-scheduler] recover failed", err);
  }

  // Faz 7: workspace index watcher + startup full scan (disk-derived state).
  void import("@/lib/tracker/workspace-index")
    .then((ws) => {
      ws.startWorkspaceWatcher();
      try {
        ws.fullWorkspaceScan();
      } catch (err) {
        console.error("[sync-scheduler] workspace startup scan failed", err);
      }
      enqueueWorkspaceScan("startup");
      scheduleWorkspaceScanTick();
    })
    .catch((err) => {
      console.error("[sync-scheduler] workspace index failed to start", err);
    });

  // Faz 8: IMAP IDLE (separate connection; paused during mail_sync / drafts).
  void import("@/lib/mail/idle-watcher")
    .then((idle) => {
      if (isOnboardingComplete() && !isAutoSyncBlockedByAuth()) {
        idle.startIdleWatcher();
      }
    })
    .catch((err) => {
      console.error("[sync-scheduler] IDLE watcher failed to start", err);
    });

  globalThis.__cmaeSyncNotifyAuthChange = () => {
    onCredentialsVersionChanged();
  };

  if (isOnboardingComplete()) {
    setTimeout(() => {
      if (!isAutoSyncBlockedByAuth()) {
        requestSync({ reason: "startup", mode: "incremental" });
        if (hasPendingDraftsReconcile()) {
          enqueueDraftsReconcile("startup");
        }
        void import("@/lib/mail/idle-watcher").then((idle) => {
          idle.startIdleWatcher();
        });
      }
      scheduleNext("interval");
      scheduleDraftsReconcileTick();
    }, STARTUP_DELAY_MS).unref?.();
  } else {
    scheduleNext("interval");
  }
}
