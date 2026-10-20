/**
 * Sync JSONL logs under userData/logs with 7-day rotation.
 * Never log passwords or mail bodies.
 */

import fs from "node:fs";
import path from "node:path";
import { getAppRoot } from "@/lib/paths";

const RETAIN_DAYS = 7;

export type SyncJsonlEvent = {
  at?: string;
  jobId?: string;
  kind?: string;
  phase?: string | null;
  event: string;
  durMs?: number;
  counts?: Record<string, number>;
  errorKind?: string | null;
  errorMessage?: string | null;
};

function logsDir(): string {
  const dir = path.join(/*turbopackIgnore: true*/ getAppRoot(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function dayStamp(d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function rotateOldLogs(dir: string): void {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(/*turbopackIgnore: true*/ dir)) {
      const m = /^sync-(\d{8})\.jsonl$/.exec(name);
      if (!m) continue;
      const stamp = m[1]!;
      const y = Number(stamp.slice(0, 4));
      const mo = Number(stamp.slice(4, 6)) - 1;
      const d = Number(stamp.slice(6, 8));
      const t = Date.UTC(y, mo, d);
      if (!Number.isFinite(t) || t >= cutoff) continue;
      try {
        fs.unlinkSync(/*turbopackIgnore: true*/ path.join(dir, name));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/** Append one sync log line. Safe to call from hot paths; failures are swallowed. */
export function appendSyncLog(entry: SyncJsonlEvent): void {
  try {
    const dir = logsDir();
    rotateOldLogs(dir);
    const file = path.join(
      /*turbopackIgnore: true*/ dir,
      `sync-${dayStamp()}.jsonl`,
    );
    const line = JSON.stringify({
      at: entry.at || new Date().toISOString(),
      jobId: entry.jobId,
      kind: entry.kind,
      phase: entry.phase ?? undefined,
      event: entry.event,
      durMs: entry.durMs,
      counts: entry.counts,
      errorKind: entry.errorKind ?? undefined,
      errorMessage: entry.errorMessage
        ? String(entry.errorMessage).slice(0, 240)
        : undefined,
    });
    fs.appendFileSync(/*turbopackIgnore: true*/ file, `${line}\n`, "utf8");
  } catch {
    /* never break sync for logging */
  }
}

export function getSyncLogsDir(): string {
  return logsDir();
}
