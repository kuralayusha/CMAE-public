/**
 * Operational diagnostics snapshot for settings / API.
 */

import { getSqlite } from "@/lib/db/client";
import { getImapConnectionCount } from "@/lib/mail/imap-connections";
import { getIdleWatcherStatus } from "@/lib/mail/idle-watcher";
import { getSyncLogsDir } from "./jsonl-log";

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx] ?? null;
}

export type DiagnosticsSnapshot = {
  at: string;
  jobs: {
    recentDurationsMs: number[];
    p50Ms: number | null;
    p95Ms: number | null;
    historyKept: number;
  };
  queues: {
    pendingDerive: number;
    needsClassification: number;
    unassigned: number;
    poisonAbandoned: number;
    mergeProposalsOpen: number;
  };
  drafts: Record<string, number>;
  sources: Array<{
    role: string;
    mailboxPath: string;
    lastSuccessAt: string | null;
    lastErrorKind: string | null;
    lastUid: number;
  }>;
  imap: {
    connections: number;
    idle: ReturnType<typeof getIdleWatcherStatus>;
  };
  llm: {
    recentJobs: number;
    llmErrorJobs: number;
    errorRate: number | null;
  };
  logsDir: string;
};

export function collectDiagnostics(): DiagnosticsSnapshot {
  const db = getSqlite();

  const jobRows = db
    .prepare(
      `SELECT started_at AS startedAt, finished_at AS finishedAt, error_kind AS errorKind
       FROM sync_jobs
       WHERE finished_at IS NOT NULL AND started_at IS NOT NULL
       ORDER BY finished_at DESC
       LIMIT 200`,
    )
    .all() as Array<{
    startedAt: string;
    finishedAt: string;
    errorKind: string | null;
  }>;

  const durations: number[] = [];
  let llmErrorJobs = 0;
  for (const row of jobRows) {
    const a = Date.parse(row.startedAt);
    const b = Date.parse(row.finishedAt);
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) {
      durations.push(b - a);
    }
    if (row.errorKind === "llm") llmErrorJobs += 1;
  }
  const sorted = [...durations].sort((x, y) => x - y);

  const count = (sql: string): number => {
    try {
      const row = db.prepare(sql).get() as { n: number } | undefined;
      return Number(row?.n) || 0;
    } catch {
      return 0;
    }
  };

  const draftRows = db
    .prepare(
      `SELECT state, COUNT(*) AS n FROM gmail_drafts GROUP BY state`,
    )
    .all() as Array<{ state: string; n: number }>;
  const drafts: Record<string, number> = {};
  for (const r of draftRows) drafts[r.state] = r.n;

  const sources = db
    .prepare(
      `SELECT role, mailbox_path AS mailboxPath,
              last_success_at AS lastSuccessAt,
              last_error_kind AS lastErrorKind,
              last_uid AS lastUid
       FROM mail_sources
       ORDER BY role`,
    )
    .all() as Array<{
    role: string;
    mailboxPath: string;
    lastSuccessAt: string | null;
    lastErrorKind: string | null;
    lastUid: number;
  }>;

  const recentJobs = jobRows.length;
  return {
    at: new Date().toISOString(),
    jobs: {
      recentDurationsMs: sorted.slice(-20),
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      historyKept: recentJobs,
    },
    queues: {
      pendingDerive: count(
        `SELECT COUNT(*) AS n FROM mail_messages WHERE derive_state = 'pending'`,
      ),
      needsClassification: count(
        `SELECT COUNT(*) AS n FROM mail_messages WHERE derive_state = 'needs_classification'`,
      ),
      unassigned: count(`SELECT COUNT(*) AS n FROM mail_unassigned`),
      poisonAbandoned: count(
        `SELECT COUNT(*) AS n FROM mail_fetch_failures WHERE abandoned = 1`,
      ),
      mergeProposalsOpen: count(
        `SELECT COUNT(*) AS n FROM merge_proposals WHERE state = 'pending'`,
      ),
    },
    drafts,
    sources,
    imap: {
      connections: getImapConnectionCount(),
      idle: getIdleWatcherStatus(),
    },
    llm: {
      recentJobs,
      llmErrorJobs,
      errorRate:
        recentJobs > 0 ? Math.round((llmErrorJobs / recentJobs) * 1000) / 1000 : null,
    },
    logsDir: getSyncLogsDir(),
  };
}
