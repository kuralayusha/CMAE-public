/**
 * Child-process entry for IMAP fetch.
 * Spawned by imap-child.ts — killed with SIGKILL on cancel so the parent stays responsive.
 *
 * Boot order: register IPC → signal ready → dynamic-import imap (avoids lost start message).
 */
import type { FetchRecentMailResult, ImapSyncMode } from "./imap";
import type { SyncLogKind } from "./types";

type StartMessage = {
  type: "start";
  address: string;
  appPassword: string;
  windowDays: number;
  mode: ImapSyncMode;
};

type ParentMessage = StartMessage | { type: "abort" };

const ac = new AbortController();
let started = false;

process.on("message", (raw: ParentMessage) => {
  if (!raw || typeof raw !== "object") return;

  if (raw.type === "abort") {
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
    process.exit(1);
    return;
  }

  if (raw.type !== "start" || started) return;
  started = true;

  void (async () => {
    try {
      const { fetchRecentMailDirect } = await import("./imap");
      const result: FetchRecentMailResult = await fetchRecentMailDirect(
        raw.address,
        raw.appPassword,
        raw.windowDays,
        {
          mode: raw.mode,
          signal: ac.signal,
          onProgress: (kind: SyncLogKind, text: string) => {
            process.send?.({ type: "progress", kind, text });
          },
        },
      );
      process.send?.({ type: "done", result });
      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.send?.({ type: "error", message });
      process.exit(1);
    }
  })();
});

process.send?.({ type: "ready" });
