import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { t } from "@/lib/i18n/t";
import { SyncCanceledError } from "./cancel";
import { killActiveImapChild } from "./imap-child";
import { listTrackerSections } from "./list";
import { runTrackerSync } from "./run";
import type { SyncMode } from "./sync";
import type { SyncLogKind, SyncLogLine } from "./types";

/** If no progress for this long, treat the session as stuck and allow a new one. */
const STUCK_SYNC_MS = 45_000;

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
  status: SyncSessionStatus;
  lines: SyncLogLine[];
  error: string | null;
  result: SyncSessionResult | null;
  createdAt: number;
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

declare global {
  // eslint-disable-next-line no-var
  var __cmaeTrackerSync: SyncSession | null | undefined;
  // eslint-disable-next-line no-var
  var __cmaeTrackerSyncBus: EventEmitter | undefined;
  // eslint-disable-next-line no-var
  var __cmaeTrackerSyncLineSeq: number | undefined;
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

function appendLine(session: SyncSession, kind: SyncLogKind, text: string) {
  const line: SyncLogLine = {
    id: nextLineId(session.id),
    kind,
    text,
    at: Date.now(),
  };
  session.lines.push(line);
  if (session.lines.length > 500) {
    session.lines.splice(0, session.lines.length - 500);
  }
  emit(session.id, { type: "line", line });
}

function finish(
  session: SyncSession,
  status: SyncSessionStatus,
  extra?: { error?: string; result?: SyncSessionResult },
) {
  session.status = status;
  if (extra?.error !== undefined) session.error = extra.error;
  if (extra?.result !== undefined) session.result = extra.result;
  if (extra?.error) {
    emit(session.id, { type: "error", error: extra.error });
  }
  if (extra?.result) {
    emit(session.id, { type: "result", result: extra.result });
  }
  emit(session.id, { type: "done", status });
}

/**
 * Start a new sync, or return the already-running one.
 * Stuck sessions (no log lines for STUCK_SYNC_MS) are force-killed first.
 */
export function startTrackerSyncSession(opts?: {
  skipImap?: boolean;
  mode?: SyncMode;
}): SyncSessionPublic {
  const existing = getActiveSyncSession();
  if (existing) {
    const lastAt = existing.lines.at(-1)?.at ?? existing.createdAt;
    if (Date.now() - lastAt < STUCK_SYNC_MS) {
      return toPublic(existing);
    }
    // Hung IMAP (often large source / signature image) — kill child + session
    appendLine(
      existing,
      "err",
      t("sync.forceResetStuck"),
    );
    try {
      existing.cancelRequested = true;
      existing.abort.abort();
    } catch {
      /* ignore */
    }
    killActiveImapChild();
    finish(existing, "canceled");
  }

  const mode: SyncMode = opts?.mode ?? "incremental";
  const abort = new AbortController();
  const session: SyncSession = {
    id: randomUUID(),
    status: "running",
    lines: [],
    error: null,
    result: null,
    createdAt: Date.now(),
    cancelRequested: false,
    abort,
  };
  globalThis.__cmaeTrackerSync = session;

  void (async () => {
    try {
      const run = await runTrackerSync({
        skipImap: opts?.skipImap,
        mode,
        signal: abort.signal,
        onProgress: (kind, text) => {
          if (session.cancelRequested || abort.signal.aborted) return;
          appendLine(session, kind, text);
        },
      });

      if (session.cancelRequested || abort.signal.aborted) {
        appendLine(session, "err", t("sync.canceled"));
        finish(session, "canceled");
        return;
      }

      const list = listTrackerSections();
      finish(session, "done", {
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
      killActiveImapChild();
      if (
        err instanceof SyncCanceledError ||
        session.cancelRequested ||
        abort.signal.aborted
      ) {
        appendLine(session, "err", t("sync.canceled"));
        finish(session, "canceled");
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      appendLine(session, "err", message);
      finish(session, "error", { error: message });
    }
  })();

  return toPublic(session);
}

export function cancelTrackerSyncSession(id?: string): SyncSessionPublic | null {
  const session = getSyncSession(id);
  if (!session) return null;
  if (session.status !== "running") return toPublic(session);

  session.cancelRequested = true;
  try {
    session.abort.abort();
  } catch {
    /* ignore */
  }
  // Child holds the IMAP socket — SIGKILL unblocks parent immediately
  killActiveImapChild();
  appendLine(session, "err", t("sync.cancelRequested"));
  // Ensure UI leaves "running" even if the async task is wedged
  setTimeout(() => {
    if (session.status === "running") {
      finish(session, "canceled");
    }
  }, 1500);
  return toPublic(session);
}

export function syncSessionHello(id: string): SyncSessionEvent | null {
  const session = getSyncSession(id);
  if (!session) return null;
  return { type: "hello", session: toPublic(session) };
}
