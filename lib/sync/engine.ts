import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import {
  bumpAppMetaInt,
  getFencingTokens,
  isMaintenanceActive,
  normalizeAccountId,
  setMaintenanceUntil,
} from "@/lib/db/app-meta";
import { getSqlite } from "@/lib/db/client";
import { t } from "@/lib/i18n/t";
import { emitTrackerEvent } from "@/lib/tracker/events-bus";
import { SyncCanceledError } from "@/lib/tracker/cancel";
import { listTrackerSections } from "@/lib/tracker/list";
import { runClassifyRetry } from "@/lib/tracker/derive/classify-retry";
import { runDraftsReconcile } from "@/lib/tracker/drafts-reconcile";
import { countLiveDrafts } from "@/lib/tracker/gmail-drafts-store";
import { runTrackerSync } from "@/lib/tracker/run";
import { getGmailCredentials } from "@/lib/settings/service";
import type { SyncMode } from "@/lib/tracker/sync";
import type { SyncLogKind, SyncLogLine } from "@/lib/tracker/types";
import {
  isAutoSyncBlockedByAuth as authBlockedAt,
  markAuthBlocked,
  notifyCredentialsChanged as notifyCredsChanged,
} from "./credentials";
import {
  classifySyncError,
  FencedError,
  retryDelayMs,
  type SyncErrorKind,
} from "./errors";
import { computeTrackerFreshness } from "./freshness";

/** Stuck = no progress for this long (IMAP batch 180s / LLM 90s). */
const PHASE_BUDGET_MS = 180_000;
const HEARTBEAT_MS = 5_000;
const STALE_LEASE_MS = 30_000;
const NON_MANUAL_DEBOUNCE_MS = 3_000;
const JOB_HISTORY_KEEP = 200;

export type SyncJobKind =
  | "mail_sync"
  | "drafts_reconcile"
  | "classify_retry"
  | "workspace_scan";
export type SyncJobState =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "canceled"
  | "interrupted";

export type SyncTriggerReason =
  | "startup"
  | "interval"
  | "resume"
  | "manual"
  | "focus"
  | "online"
  | "post_mutation"
  | "idle"
  | "retry"
  | "wake";

export type SyncSessionStatus = "running" | "done" | "error" | "canceled";

export type SyncSessionResult = {
  skippedImap: boolean;
  skipReason?: string;
  upserted: number;
  itemCount: number;
  mode?: SyncMode;
  keptOutsideWindow?: number;
  sections: ReturnType<typeof listTrackerSections>["sections"];
  sync: ReturnType<typeof listTrackerSections>["sync"];
  total: number;
};

export type SyncSession = {
  id: string;
  jobId: string;
  status: SyncSessionStatus;
  lines: SyncLogLine[];
  error: string | null;
  result: SyncSessionResult | null;
  createdAt: number;
  progressAt: number;
  cancelRequested: boolean;
  abort: AbortController;
};

export type SyncSessionEvent =
  | { type: "hello"; session: SyncSessionPublic }
  | { type: "line"; line: SyncLogLine }
  | { type: "result"; result: SyncSessionResult }
  | { type: "error"; error: string }
  | { type: "done"; status: SyncSessionStatus };

export type SyncSessionPublic = {
  id: string;
  status: SyncSessionStatus;
  lines: SyncLogLine[];
  error: string | null;
  result: SyncSessionResult | null;
  createdAt: number;
};

type JobRow = {
  id: string;
  kind: string;
  mode: string;
  state: string;
  phase: string | null;
  reasons: string;
  rerun_requested: number;
  rerun_mode: string | null;
  attempt: number;
  owner: string | null;
  db_epoch: number;
  credentials_version: number;
  account_id: string;
  error_kind: string | null;
  error_message: string | null;
  queued_at: string;
  started_at: string | null;
  heartbeat_at: string | null;
  progress_at: string | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __cmaeTrackerSync: SyncSession | null | undefined;
  // eslint-disable-next-line no-var
  var __cmaeTrackerSyncBus: EventEmitter | undefined;
  // eslint-disable-next-line no-var
  var __cmaeTrackerSyncLineSeq: number | undefined;
  // eslint-disable-next-line no-var
  var __cmaeSyncOwnerId: string | undefined;
  // eslint-disable-next-line no-var
  var __cmaeSyncPumpRunning: boolean | undefined;
  // eslint-disable-next-line no-var
  var __cmaeSyncDebounceTimer: ReturnType<typeof setTimeout> | null | undefined;
  // eslint-disable-next-line no-var
  var __cmaeSyncPendingRequest:
    | { reason: SyncTriggerReason; mode: SyncMode }
    | null
    | undefined;
}

function ownerId(): string {
  if (!globalThis.__cmaeSyncOwnerId) {
    globalThis.__cmaeSyncOwnerId = `${randomUUID()}:pid${process.pid}`;
  }
  return globalThis.__cmaeSyncOwnerId;
}

function getBus(): EventEmitter {
  if (!globalThis.__cmaeTrackerSyncBus) {
    globalThis.__cmaeTrackerSyncBus = new EventEmitter();
    globalThis.__cmaeTrackerSyncBus.setMaxListeners(50);
  }
  return globalThis.__cmaeTrackerSyncBus;
}

function nextLineId(sessionId: string): string {
  if (!globalThis.__cmaeTrackerSyncLineSeq) {
    globalThis.__cmaeTrackerSyncLineSeq = 0;
  }
  return `${sessionId}-${++globalThis.__cmaeTrackerSyncLineSeq}`;
}

function toPublic(session: SyncSession): SyncSessionPublic {
  return {
    id: session.id,
    status: session.status,
    lines: session.lines,
    error: session.error,
    result: session.result,
    createdAt: session.createdAt,
  };
}

function emit(sessionId: string, event: SyncSessionEvent) {
  getBus().emit(`sync:${sessionId}`, event);
}

function emitFreshness() {
  try {
    emitTrackerEvent({
      type: "freshness",
      freshness: computeTrackerFreshness(),
    });
  } catch {
    /* ignore */
  }
}

function emitJobEvent(job: {
  id: string;
  kind: string;
  state: string;
  phase?: string | null;
}) {
  emitTrackerEvent({
    type: "job",
    jobId: job.id,
    kind: job.kind,
    state: job.state,
    phase: job.phase ?? undefined,
  });
  emitFreshness();
}

function modeRank(mode: SyncMode): number {
  if (mode === "hard") return 2;
  return 1;
}

function maxMode(a: SyncMode, b: SyncMode): SyncMode {
  return modeRank(a) >= modeRank(b) ? a : b;
}

function parseReasons(raw: string): SyncTriggerReason[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is SyncTriggerReason => typeof x === "string");
  } catch {
    return [];
  }
}

function mergeReasons(
  existing: SyncTriggerReason[],
  reason: SyncTriggerReason,
): SyncTriggerReason[] {
  if (existing.includes(reason)) return existing;
  return [...existing, reason];
}

function isoNow(): string {
  return new Date().toISOString();
}

function assertFencing(job: {
  db_epoch: number;
  credentials_version: number;
  account_id: string;
}): void {
  const cur = getFencingTokens();
  if (
    cur.dbEpoch !== job.db_epoch ||
    cur.credentialsVersion !== job.credentials_version ||
    (job.account_id || "") !== (cur.accountId || "")
  ) {
    throw new FencedError();
  }
}

function interruptStaleLeases(db = getSqlite()): number {
  const cutoff = new Date(Date.now() - STALE_LEASE_MS).toISOString();
  const res = db
    .prepare(
      `UPDATE sync_jobs
       SET state = 'interrupted',
           error_kind = COALESCE(error_kind, 'stuck'),
           error_message = COALESCE(error_message, 'lease heartbeat expired'),
           finished_at = ?
       WHERE state = 'running'
         AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
    )
    .run(isoNow(), cutoff);
  return res.changes;
}

function pruneJobHistory(db = getSqlite()): void {
  db.prepare(
    `DELETE FROM sync_jobs
     WHERE id NOT IN (
       SELECT id FROM sync_jobs ORDER BY queued_at DESC LIMIT ?
     )`,
  ).run(JOB_HISTORY_KEEP);
}

function getRunningJob(kind: SyncJobKind = "mail_sync"): JobRow | null {
  return (
    (getSqlite()
      .prepare(
        `SELECT * FROM sync_jobs WHERE kind = ? AND state = 'running' LIMIT 1`,
      )
      .get(kind) as JobRow | undefined) ?? null
  );
}

function getQueuedJob(kind: SyncJobKind = "mail_sync"): JobRow | null {
  return (
    (getSqlite()
      .prepare(
        `SELECT * FROM sync_jobs
         WHERE kind = ? AND state = 'queued'
         ORDER BY queued_at ASC
         LIMIT 1`,
      )
      .get(kind) as JobRow | undefined) ?? null
  );
}

/** Next queued job: mail_sync → drafts_reconcile → classify_retry → workspace_scan. */
function getQueuedJobAny(): JobRow | null {
  // Disk index does not need Gmail — still run when auth is blocked.
  if (isAutoSyncBlockedByAuth()) {
    return getQueuedJob("workspace_scan");
  }
  return (
    getQueuedJob("mail_sync") ||
    getQueuedJob("drafts_reconcile") ||
    getQueuedJob("classify_retry") ||
    getQueuedJob("workspace_scan")
  );
}

function enqueueJobOfKind(
  kind: SyncJobKind,
  reason: SyncTriggerReason,
): string | null {
  if (getRunningJob(kind) || getQueuedJob(kind)) {
    return getQueuedJob(kind)?.id || getRunningJob(kind)?.id || null;
  }
  const db = getSqlite();
  const fencing = getFencingTokens(db);
  const accountId = ensureAccountIdMeta() || fencing.accountId;
  const id = randomUUID();
  const now = isoNow();
  db.prepare(
    `INSERT INTO sync_jobs (
      id, kind, mode, state, phase, reasons, rerun_requested, rerun_mode,
      attempt, owner, db_epoch, credentials_version, account_id,
      queued_at, progress_at
    ) VALUES (?, ?, 'incremental', 'queued', NULL, ?, 0, NULL, 1, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    kind,
    JSON.stringify([reason]),
    fencing.dbEpoch,
    fencing.credentialsVersion,
    accountId,
    now,
    now,
  );
  emitJobEvent({ id, kind, state: "queued" });
  pumpJobs();
  return id;
}

/** Enqueue classify_retry when provisional regex intents remain (Faz 4). */
export function enqueueClassifyRetry(
  reason: SyncTriggerReason = "post_mutation",
): string | null {
  return enqueueJobOfKind("classify_retry", reason);
}

/** Enqueue drafts_reconcile (post draft create / mail sync / interval). */
export function enqueueDraftsReconcile(
  reason: SyncTriggerReason = "post_mutation",
): string | null {
  return enqueueJobOfKind("drafts_reconcile", reason);
}

/** Enqueue workspace_scan (startup / 10‑min safety net). */
export function enqueueWorkspaceScan(
  reason: SyncTriggerReason = "interval",
): string | null {
  return enqueueJobOfKind("workspace_scan", reason);
}

/** True when live gmail_drafts rows exist (for 2‑min interval). */
export function hasPendingDraftsReconcile(): boolean {
  try {
    return countLiveDrafts(currentAccountId() || undefined) > 0;
  } catch {
    return false;
  }
}

function isSessionStuck(session: SyncSession): boolean {
  return Date.now() - session.progressAt >= PHASE_BUDGET_MS;
}

function appendLine(session: SyncSession, kind: SyncLogKind, text: string) {
  const line: SyncLogLine = {
    id: nextLineId(session.id),
    kind,
    text,
    at: Date.now(),
  };
  session.progressAt = line.at;
  session.lines.push(line);
  if (session.lines.length > 500) {
    session.lines.splice(0, session.lines.length - 500);
  }
  try {
    getSqlite()
      .prepare(
        `UPDATE sync_jobs SET progress_at = ?, heartbeat_at = ? WHERE id = ? AND state = 'running'`,
      )
      .run(isoNow(), isoNow(), session.jobId);
  } catch {
    /* ignore */
  }
  emit(session.id, { type: "line", line });
}

function finishSession(
  session: SyncSession,
  status: SyncSessionStatus,
  extra?: { error?: string; result?: SyncSessionResult },
) {
  session.status = status;
  if (extra?.error !== undefined) session.error = extra.error;
  if (extra?.result !== undefined) session.result = extra.result;
  if (extra?.error) emit(session.id, { type: "error", error: extra.error });
  if (extra?.result) emit(session.id, { type: "result", result: extra.result });
  emit(session.id, { type: "done", status });
}

function currentAccountId(): string {
  const creds = getGmailCredentials();
  return normalizeAccountId(creds?.address);
}

function ensureAccountIdMeta(): string {
  const id = currentAccountId();
  const db = getSqlite();
  const cur = getFencingTokens(db);
  if (id && cur.accountId !== id) {
    // Same-address bootstrap / first sync — set without bumping epoch.
    db.prepare(
      `INSERT INTO app_meta (key, value) VALUES ('account_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(id);
  }
  return getFencingTokens(db).accountId || id;
}

function insertQueuedJob(opts: {
  reason: SyncTriggerReason;
  mode: SyncMode;
  attempt?: number;
}): string {
  const db = getSqlite();
  const fencing = getFencingTokens(db);
  const accountId = ensureAccountIdMeta() || fencing.accountId;
  const id = randomUUID();
  const now = isoNow();
  db.prepare(
    `INSERT INTO sync_jobs (
      id, kind, mode, state, phase, reasons, rerun_requested, rerun_mode,
      attempt, owner, db_epoch, credentials_version, account_id,
      queued_at, progress_at
    ) VALUES (?, 'mail_sync', ?, 'queued', NULL, ?, 0, NULL, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.mode,
    JSON.stringify([opts.reason]),
    opts.attempt ?? 1,
    fencing.dbEpoch,
    fencing.credentialsVersion,
    accountId,
    now,
    now,
  );
  emitJobEvent({ id, kind: "mail_sync", state: "queued" });
  return id;
}

export function isAutoSyncBlockedByAuth(): boolean {
  return authBlockedAt(getFencingTokens().credentialsVersion);
}

export function notifyCredentialsChanged(): void {
  ensureAccountIdMeta();
  notifyCredsChanged();
}

/**
 * Coalescing entry point. Manual never kills a healthy in-budget job.
 */
export function requestSync(opts: {
  reason: SyncTriggerReason;
  mode?: SyncMode;
}): { jobId: string; joined: boolean; session: SyncSessionPublic | null } {
  const mode: SyncMode = opts.mode ?? "incremental";
  const reason = opts.reason;

  if (reason !== "manual") {
    // Debounce non-manual triggers.
    globalThis.__cmaeSyncPendingRequest = { reason, mode };
    if (globalThis.__cmaeSyncDebounceTimer) {
      clearTimeout(globalThis.__cmaeSyncDebounceTimer);
    }
    globalThis.__cmaeSyncDebounceTimer = setTimeout(() => {
      globalThis.__cmaeSyncDebounceTimer = null;
      const pending = globalThis.__cmaeSyncPendingRequest;
      globalThis.__cmaeSyncPendingRequest = null;
      if (pending) {
        requestSyncImmediate(pending);
      }
    }, NON_MANUAL_DEBOUNCE_MS);
    if (
      typeof globalThis.__cmaeSyncDebounceTimer === "object" &&
      globalThis.__cmaeSyncDebounceTimer &&
      "unref" in globalThis.__cmaeSyncDebounceTimer
    ) {
      globalThis.__cmaeSyncDebounceTimer.unref();
    }
    const running = getRunningJob();
    const queued = getQueuedJob();
    const session = getActiveSyncSession();
    return {
      jobId: running?.id || queued?.id || "",
      joined: Boolean(running || queued),
      session: session ? toPublic(session) : null,
    };
  }

  return requestSyncImmediate({ reason, mode });
}

function requestSyncImmediate(opts: {
  reason: SyncTriggerReason;
  mode: SyncMode;
}): { jobId: string; joined: boolean; session: SyncSessionPublic | null } {
  const { reason, mode } = opts;

  if (isMaintenanceActive()) {
    return { jobId: "", joined: false, session: null };
  }

  if (reason !== "manual" && isAutoSyncBlockedByAuth()) {
    return { jobId: "", joined: false, session: null };
  }

  // Focus/online: skip if last success < 60s
  if (reason === "focus" || reason === "online") {
    try {
      const row = getSqlite()
        .prepare(
          `SELECT finished_at AS finishedAt FROM sync_jobs
           WHERE kind = 'mail_sync' AND state IN ('succeeded','partial')
           ORDER BY finished_at DESC LIMIT 1`,
        )
        .get() as { finishedAt: string } | undefined;
      if (row?.finishedAt) {
        const age = Date.now() - Date.parse(row.finishedAt);
        if (Number.isFinite(age) && age < 60_000) {
          const session = getActiveSyncSession();
          return {
            jobId: "",
            joined: false,
            session: session ? toPublic(session) : null,
          };
        }
      }
    } catch {
      /* continue */
    }
  }

  const db = getSqlite();
  let jobId = "";
  let joined = false;

  db.transaction(() => {
    interruptStaleLeases(db);

    const running = getRunningJob();
    if (running) {
      joined = true;
      jobId = running.id;
      const reasons = mergeReasons(parseReasons(running.reasons), reason);
      const nextMode = maxMode(
        (running.mode as SyncMode) || "incremental",
        mode,
      );
      const rerunMode = running.rerun_mode
        ? maxMode(running.rerun_mode as SyncMode, mode)
        : mode;
      db.prepare(
        `UPDATE sync_jobs
         SET reasons = ?,
             rerun_requested = 1,
             rerun_mode = ?,
             mode = CASE WHEN ? > 1 THEN ? ELSE mode END
         WHERE id = ?`,
      ).run(
        JSON.stringify(reasons),
        rerunMode,
        modeRank(mode),
        nextMode,
        running.id,
      );

      // Manual click on stuck in-memory session: force cancel so pump can replace.
      const session = getActiveSyncSession();
      if (reason === "manual" && session && isSessionStuck(session)) {
        appendLine(session, "err", t("sync.forceResetStuck"));
        session.cancelRequested = true;
        try {
          session.abort.abort();
        } catch {
          /* ignore */
        }
        db.prepare(
          `UPDATE sync_jobs
           SET state = 'interrupted',
               error_kind = 'stuck',
               error_message = 'phase budget exceeded',
               finished_at = ?
           WHERE id = ? AND state = 'running'`,
        ).run(isoNow(), running.id);
        joined = false;
        jobId = insertQueuedJob({ reason, mode });
      }
      return;
    }

    const queued = getQueuedJob();
    if (queued) {
      joined = true;
      jobId = queued.id;
      const reasons = mergeReasons(parseReasons(queued.reasons), reason);
      const nextMode = maxMode((queued.mode as SyncMode) || "incremental", mode);
      db.prepare(
        `UPDATE sync_jobs SET reasons = ?, mode = ? WHERE id = ?`,
      ).run(JSON.stringify(reasons), nextMode, queued.id);
      return;
    }

    jobId = insertQueuedJob({ reason, mode });
  })();

  pumpJobs();

  const session = getActiveSyncSession();
  return {
    jobId: session?.jobId || jobId,
    joined,
    session: session ? toPublic(session) : null,
  };
}

/**
 * Claim the next queued job synchronously (so callers can attach streams
 * immediately), then run it asynchronously.
 */
function pumpJobs(): void {
  if (globalThis.__cmaeSyncPumpRunning) return;
  const first = claimNextJob();
  if (!first) return;
  globalThis.__cmaeSyncPumpRunning = true;
  void (async () => {
    try {
      let current: JobRow | null = first;
      while (current) {
        await runClaimedJob(current);
        current = claimNextJob();
      }
    } finally {
      globalThis.__cmaeSyncPumpRunning = false;
      // A job may have been queued while we were finishing — pick it up.
      if (getQueuedJobAny()) pumpJobs();
    }
  })();
}

function claimNextJob(): JobRow | null {
  const db = getSqlite();
  let claimed: JobRow | null = null;

  try {
    claimed = db.transaction((): JobRow | null => {
      interruptStaleLeases(db);
      if (isMaintenanceActive(db)) return null;

      // Re-queue interrupted jobs.
      db.prepare(
        `UPDATE sync_jobs
         SET state = 'queued', owner = NULL, started_at = NULL, heartbeat_at = NULL,
             finished_at = NULL, error_kind = NULL, error_message = NULL
         WHERE kind IN ('mail_sync', 'drafts_reconcile', 'classify_retry', 'workspace_scan')
           AND state = 'interrupted'`,
      ).run();

      const queued = getQueuedJobAny();
      if (!queued) return null;
      if (
        isAutoSyncBlockedByAuth() &&
        queued.kind !== "workspace_scan" &&
        !parseReasons(queued.reasons).includes("manual")
      ) {
        return null;
      }

      const fencing = getFencingTokens(db);
      const accountId = ensureAccountIdMeta() || fencing.accountId;
      const now = isoNow();
      const owner = ownerId();

      const res = db
        .prepare(
          `UPDATE sync_jobs
           SET state = 'running',
               owner = ?,
               started_at = ?,
               heartbeat_at = ?,
               progress_at = ?,
               phase = 'connecting',
               db_epoch = ?,
               credentials_version = ?,
               account_id = ?
           WHERE id = ? AND state = 'queued'`,
        )
        .run(
          owner,
          now,
          now,
          now,
          fencing.dbEpoch,
          fencing.credentialsVersion,
          accountId,
          queued.id,
        );

      if (!res.changes) return null;

      return (
        (db
          .prepare(`SELECT * FROM sync_jobs WHERE id = ?`)
          .get(queued.id) as JobRow | undefined) ?? null
      );
    })();
  } catch (err) {
    // Unique index collision — another process claimed.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.toLowerCase().includes("unique")) {
      console.error("[sync-engine] claim failed", err);
    }
    return null;
  }

  if (claimed) {
    emitJobEvent({
      id: claimed.id,
      kind: claimed.kind,
      state: "running",
      phase: claimed.phase,
    });
  }
  return claimed;
}

async function runClaimedJob(job: JobRow): Promise<void> {
  const abort = new AbortController();
  const now = Date.now();
  const session: SyncSession = {
    id: job.id,
    jobId: job.id,
    status: "running",
    lines: [],
    error: null,
    result: null,
    createdAt: now,
    progressAt: now,
    cancelRequested: false,
    abort,
  };
  globalThis.__cmaeTrackerSync = session;

  const heartbeat = setInterval(() => {
    try {
      assertFencing(job);
      getSqlite()
        .prepare(
          `UPDATE sync_jobs SET heartbeat_at = ? WHERE id = ? AND state = 'running'`,
        )
        .run(isoNow(), job.id);
    } catch (err) {
      if (err instanceof FencedError) {
        session.cancelRequested = true;
        try {
          abort.abort();
        } catch {
          /* ignore */
        }
      }
    }
  }, HEARTBEAT_MS);
  if (typeof heartbeat === "object" && "unref" in heartbeat) {
    heartbeat.unref();
  }

  const mode = (job.mode as SyncMode) || "incremental";

  try {
    assertFencing(job);

    if (job.kind === "classify_retry") {
      const result = await runClassifyRetry({
        signal: abort.signal,
        onProgress: (kind, text) => {
          if (session.cancelRequested || abort.signal.aborted) return;
          appendLine(session, kind, text);
        },
      });
      assertFencing(job);
      finishJob(job, "succeeded", {
        stats: {
          classified: result.classified,
          stillPending: result.stillPending,
        },
      });
      if (result.stillPending > 0) {
        const delay = retryDelayMs(job.attempt || 1);
        setTimeout(() => {
          if (isAutoSyncBlockedByAuth() || isMaintenanceActive()) return;
          enqueueClassifyRetry("retry");
        }, delay).unref?.();
      }
      const list = listTrackerSections();
      finishSession(session, "done", {
        result: {
          skippedImap: true,
          upserted: 0,
          itemCount: list.total,
          sections: list.sections,
          sync: list.sync,
          total: list.total,
        },
      });
      return;
    }

    if (job.kind === "drafts_reconcile") {
      const result = await runDraftsReconcile({
        signal: abort.signal,
        onProgress: (kind, text) => {
          if (session.cancelRequested || abort.signal.aborted) return;
          appendLine(session, kind, text);
        },
      });
      assertFencing(job);
      finishJob(job, "succeeded", {
        stats: {
          checked: result.checked,
          present: result.present,
          sent: result.sent,
          deleted: result.deleted,
          failed: result.failed,
        },
      });
      if (result.triggerMailSync) {
        // Sent from Gmail — pull outbound so status advances.
        setTimeout(() => {
          if (isAutoSyncBlockedByAuth() || isMaintenanceActive()) return;
          requestSync({ reason: "post_mutation", mode: "incremental" });
        }, 60_000).unref?.();
        requestSync({ reason: "post_mutation", mode: "incremental" });
      }
      const list = listTrackerSections();
      finishSession(session, "done", {
        result: {
          skippedImap: true,
          upserted: 0,
          itemCount: list.total,
          sections: list.sections,
          sync: list.sync,
          total: list.total,
        },
      });
      return;
    }

    if (job.kind === "workspace_scan") {
      const { fullWorkspaceScan } = await import(
        "@/lib/tracker/workspace-index"
      );
      appendLine(session, "think", "Scanning workspace folders…");
      const result = fullWorkspaceScan();
      assertFencing(job);
      finishJob(job, "succeeded", {
        stats: {
          folders: result.folders,
          changed: result.changed ? 1 : 0,
          missing: result.missing,
        },
      });
      const list = listTrackerSections();
      finishSession(session, "done", {
        result: {
          skippedImap: true,
          upserted: 0,
          itemCount: list.total,
          sections: list.sections,
          sync: list.sync,
          total: list.total,
        },
      });
      return;
    }

    const run = await runTrackerSync({
      mode,
      signal: abort.signal,
      onProgress: (kind, text) => {
        if (session.cancelRequested || abort.signal.aborted) return;
        try {
          assertFencing(job);
        } catch {
          session.cancelRequested = true;
          try {
            abort.abort();
          } catch {
            /* ignore */
          }
          return;
        }
        appendLine(session, kind, text);
        // Rough phase from log text prefixes — good enough until Faz 3 phases.
        const phase =
          kind === "curl"
            ? "connecting"
            : kind === "think"
              ? "derive"
              : kind === "ok"
                ? "finalize"
                : null;
        if (phase) {
          try {
            getSqlite()
              .prepare(
                `UPDATE sync_jobs SET phase = ?, progress_at = ? WHERE id = ? AND state = 'running'`,
              )
              .run(phase, isoNow(), job.id);
          } catch {
            /* ignore */
          }
        }
      },
    });

    if (session.cancelRequested || abort.signal.aborted) {
      appendLine(session, "err", t("sync.canceled"));
      finishJob(job, "canceled", {
        errorKind: "canceled",
        errorMessage: t("sync.canceled"),
      });
      finishSession(session, "canceled");
      return;
    }

    assertFencing(job);

    // If regex intents still provisional, enqueue dedicated retry job.
    try {
      const pending = getSqlite()
        .prepare(
          `SELECT COUNT(*) AS n FROM mail_messages WHERE derive_state = 'needs_classification'`,
        )
        .get() as { n: number };
      if (pending?.n > 0) enqueueClassifyRetry("post_mutation");
    } catch {
      /* ignore */
    }

    // Drafts reconcile after every successful mail sync (separate job).
    try {
      if (countLiveDrafts(currentAccountId() || undefined) > 0) {
        enqueueDraftsReconcile("post_mutation");
      }
    } catch {
      /* ignore */
    }

    const list = listTrackerSections();
    const terminal: SyncJobState = run.partial ? "partial" : "succeeded";
    finishJob(job, terminal, {
      stats: {
        upserted: run.upserted,
        itemCount: run.itemCount,
        partial: run.partial,
      },
    });
    finishSession(session, "done", {
      result: {
        skippedImap: run.skippedImap,
        skipReason: run.skipReason,
        upserted: run.upserted,
        itemCount: run.itemCount,
        mode: run.mode,
        keptOutsideWindow: run.keptOutsideWindow,
        ...list,
      },
    });
  } catch (err) {
    if (
      err instanceof FencedError ||
      (err instanceof Error && err.name === "FencedError")
    ) {
      finishJob(job, "canceled", {
        errorKind: "fenced",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      appendLine(session, "err", t("sync.canceled"));
      finishSession(session, "canceled");
      return;
    }
    if (
      err instanceof SyncCanceledError ||
      session.cancelRequested ||
      abort.signal.aborted
    ) {
      appendLine(session, "err", t("sync.canceled"));
      finishJob(job, "canceled", {
        errorKind: "canceled",
        errorMessage: t("sync.canceled"),
      });
      finishSession(session, "canceled");
      return;
    }

    const classified = classifySyncError(err);
    appendLine(session, "err", classified.message);
    finishJob(job, "failed", {
      errorKind: classified.kind,
      errorMessage: classified.message,
      attempt: job.attempt,
    });
    finishSession(session, "error", { error: classified.message });

    if (classified.kind === "auth") {
      markAuthBlocked(job.credentials_version);
    } else if (
      classified.kind !== "canceled" &&
      classified.kind !== "fenced" &&
      classified.kind !== "canceled_by_reset"
    ) {
      scheduleRetry(job, classified.kind);
    }
  } finally {
    clearInterval(heartbeat);
    // Handle rerun_requested
    try {
      const fresh = getSqlite()
        .prepare(`SELECT * FROM sync_jobs WHERE id = ?`)
        .get(job.id) as JobRow | undefined;
      if (
        fresh &&
        fresh.rerun_requested &&
        (fresh.state === "succeeded" ||
          fresh.state === "partial" ||
          fresh.state === "failed")
      ) {
        const rerunMode = (fresh.rerun_mode as SyncMode) || "incremental";
        getSqlite()
          .prepare(`UPDATE sync_jobs SET rerun_requested = 0, rerun_mode = NULL WHERE id = ?`)
          .run(job.id);
        if (!isMaintenanceActive() && !isAutoSyncBlockedByAuth()) {
          insertQueuedJob({ reason: "manual", mode: rerunMode });
        }
      }
    } catch {
      /* ignore */
    }
    pruneJobHistory();
    emitFreshness();
  }
}

function finishJob(
  job: JobRow,
  state: SyncJobState,
  extra?: {
    errorKind?: SyncErrorKind | string;
    errorMessage?: string;
    stats?: Record<string, unknown>;
    attempt?: number;
  },
): void {
  const now = isoNow();
  getSqlite()
    .prepare(
      `UPDATE sync_jobs
       SET state = ?,
           phase = 'finalize',
           error_kind = ?,
           error_message = ?,
           stats_json = ?,
           finished_at = ?,
           heartbeat_at = ?
       WHERE id = ?`,
    )
    .run(
      state,
      extra?.errorKind ?? null,
      extra?.errorMessage ?? null,
      extra?.stats ? JSON.stringify(extra.stats) : null,
      now,
      now,
      job.id,
    );
  emitJobEvent({ id: job.id, kind: job.kind, state, phase: "finalize" });
}

function scheduleRetry(job: JobRow, errorKind: string): void {
  if (errorKind === "auth") return;
  const attempt = (job.attempt || 1) + 1;
  const delay = retryDelayMs(attempt - 1);
  const nextAt = new Date(Date.now() + delay).toISOString();
  getSqlite()
    .prepare(`UPDATE sync_jobs SET next_retry_at = ?, attempt = ? WHERE id = ?`)
    .run(nextAt, attempt, job.id);

  setTimeout(() => {
    if (isAutoSyncBlockedByAuth() || isMaintenanceActive()) return;
    requestSync({ reason: "retry", mode: (job.mode as SyncMode) || "incremental" });
  }, delay).unref?.();
}

export function getSyncSession(id?: string): SyncSession | null {
  const cur = globalThis.__cmaeTrackerSync ?? null;
  if (!cur) return null;
  if (id && cur.id !== id) return null;
  return cur;
}

export function getActiveSyncSession(): SyncSession | null {
  const cur = getSyncSession();
  if (!cur) return null;
  if (cur.status === "running") return cur;
  return null;
}

export function subscribeSyncSession(
  id: string,
  listener: (event: SyncSessionEvent) => void,
): () => void {
  const channel = `sync:${id}`;
  getBus().on(channel, listener);
  return () => getBus().off(channel, listener);
}

export function syncSessionHello(id: string): SyncSessionEvent | null {
  const session = getSyncSession(id);
  if (!session) return null;
  return { type: "hello", session: toPublic(session) };
}

/** API-compatible: start or join; never kill healthy job on manual click. */
export function startTrackerSyncSession(opts?: {
  skipImap?: boolean;
  mode?: SyncMode;
  reason?: SyncTriggerReason;
}): SyncSessionPublic {
  if (opts?.skipImap) {
    // Rare path — run without queueing a full IMAP job (legacy).
    return startSkipImapSession(opts.mode ?? "incremental");
  }

  const result = requestSyncImmediate({
    reason: opts?.reason ?? "manual",
    mode: opts?.mode ?? "incremental",
  });

  if (result.session) return result.session;

  const existing = getActiveSyncSession();
  if (existing) return toPublic(existing);

  if (result.jobId) {
    return {
      id: result.jobId,
      status: "running",
      lines: [],
      error: null,
      result: null,
      createdAt: Date.now(),
    };
  }

  return {
    id: randomUUID(),
    status: "error",
    lines: [],
    error: "Could not start sync",
    result: null,
    createdAt: Date.now(),
  };
}

function startSkipImapSession(mode: SyncMode): SyncSessionPublic {
  const abort = new AbortController();
  const now = Date.now();
  const id = randomUUID();
  const session: SyncSession = {
    id,
    jobId: id,
    status: "running",
    lines: [],
    error: null,
    result: null,
    createdAt: now,
    progressAt: now,
    cancelRequested: false,
    abort,
  };
  globalThis.__cmaeTrackerSync = session;

  void (async () => {
    try {
      const run = await runTrackerSync({
        skipImap: true,
        mode,
        signal: abort.signal,
        onProgress: (kind, text) => appendLine(session, kind, text),
      });
      const list = listTrackerSections();
      finishSession(session, "done", {
        result: {
          skippedImap: run.skippedImap,
          skipReason: run.skipReason,
          upserted: run.upserted,
          itemCount: run.itemCount,
          mode: run.mode,
          keptOutsideWindow: run.keptOutsideWindow,
          ...list,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finishSession(session, "error", { error: message });
    }
  })();

  return toPublic(session);
}

export function cancelTrackerSyncSession(id?: string): SyncSessionPublic | null {
  const session = getSyncSession(id);
  const db = getSqlite();

  if (session && session.status === "running") {
    session.cancelRequested = true;
    try {
      session.abort.abort();
    } catch {
      /* ignore */
    }
    appendLine(session, "err", t("sync.cancelRequested"));
    try {
      db.prepare(
        `UPDATE sync_jobs
         SET state = 'canceled',
             error_kind = 'canceled',
             error_message = ?,
             finished_at = ?
         WHERE id = ? AND state IN ('running','queued')`,
      ).run(t("sync.cancelRequested"), isoNow(), session.jobId);
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (session.status === "running") {
        finishSession(session, "canceled");
      }
    }, 1500);
    return toPublic(session);
  }

  // Cancel queued jobs even without in-memory session.
  db.prepare(
    `UPDATE sync_jobs
     SET state = 'canceled',
         error_kind = 'canceled_by_reset',
         error_message = 'canceled',
         finished_at = ?
     WHERE kind = 'mail_sync' AND state IN ('queued','running')`,
  ).run(isoNow());

  return session ? toPublic(session) : null;
}

export async function waitForSyncSessionIdle(
  maxMs = 5_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const running = getRunningJob();
    const active = getActiveSyncSession();
    if (!running && !active) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !getRunningJob() && !getActiveSyncSession();
}

/**
 * Onboarding reset: maintenance → cancel → wait → bump db_epoch.
 * Caller then wipes DB.
 */
export async function prepareResetFencing(): Promise<void> {
  const until = new Date(Date.now() + 60_000).toISOString();
  setMaintenanceUntil(until);
  cancelTrackerSyncSession();
  await waitForSyncSessionIdle(5_000);
  bumpAppMetaInt("db_epoch");
}

export function clearMaintenance(): void {
  setMaintenanceUntil("");
}

/** Recover stale leases at process start. */
export function recoverInterruptedJobs(): void {
  try {
    const db = getSqlite();
    db.transaction(() => {
      interruptStaleLeases(db);
      db.prepare(
        `UPDATE sync_jobs
         SET state = 'interrupted',
             error_kind = COALESCE(error_kind, 'stuck'),
             error_message = COALESCE(error_message, 'process restarted'),
             finished_at = ?
         WHERE state = 'running'`,
      ).run(isoNow());
    })();
  } catch (err) {
    console.error("[sync-engine] recover failed", err);
  }
}
