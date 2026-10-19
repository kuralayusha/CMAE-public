import { type ChildProcess, fork } from "node:child_process";
import path from "node:path";
import { throwIfSyncCanceled } from "./cancel";
import type { FetchRecentMailResult, ImapSyncMode } from "./imap";
import type { SyncProgressFn } from "./types";

declare global {
  // eslint-disable-next-line no-var
  var __cmaeImapChild: ChildProcess | null | undefined;
}

function childEntryPath(): string {
  return path.join(process.cwd(), "lib/tracker/imap-sync-child.ts");
}

function killImapChild(child: ChildProcess | null | undefined) {
  if (!child || child.killed) return;
  try {
    child.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}

/** Force-kill any in-flight IMAP child (cancel / stuck session). */
export function killActiveImapChild() {
  killImapChild(globalThis.__cmaeImapChild);
  globalThis.__cmaeImapChild = null;
}

/**
 * Run IMAP fetch in a forked process. Parent event loop stays free for HTTP/SSE/cancel.
 */
export function runImapFetchInChild(
  address: string,
  appPassword: string,
  windowDays: number,
  opts?: {
    mode?: ImapSyncMode;
    onProgress?: SyncProgressFn;
    signal?: AbortSignal;
  },
): Promise<FetchRecentMailResult> {
  throwIfSyncCanceled(opts?.signal);

  // Only one IMAP child at a time
  killActiveImapChild();

  const mode: ImapSyncMode = opts?.mode ?? "incremental";
  const child = fork(childEntryPath(), [], {
    // react-server → server-only resolves to empty stub (plain Node throws otherwise)
    execArgv: ["--import", "tsx", "--conditions=react-server"],
    env: { ...process.env, CMAE_IMAP_IN_CHILD: "1" },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  globalThis.__cmaeImapChild = child;

  return new Promise<FetchRecentMailResult>((resolve, reject) => {
    let settled = false;
    let lastChildError: string | null = null;

    const cleanup = () => {
      if (globalThis.__cmaeImapChild === child) {
        globalThis.__cmaeImapChild = null;
      }
      opts?.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onAbort = () => {
      try {
        child.send({ type: "abort" });
      } catch {
        /* ignore */
      }
      killImapChild(child);
      finish(() => reject(new Error("IMAP sync canceled")));
    };

    if (opts?.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const sendStart = () => {
      try {
        child.send({
          type: "start",
          address,
          appPassword,
          windowDays,
          mode,
        });
      } catch (err) {
        finish(() =>
          reject(err instanceof Error ? err : new Error(String(err))),
        );
      }
    };

    child.on("message", (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg as {
        type?: string;
        kind?: Parameters<SyncProgressFn>[0];
        text?: string;
        result?: FetchRecentMailResult;
        message?: string;
      };
      if (m.type === "ready") {
        sendStart();
        return;
      }
      if (m.type === "progress" && m.kind && typeof m.text === "string") {
        opts?.onProgress?.(m.kind, m.text);
        return;
      }
      if (m.type === "done" && m.result) {
        finish(() => resolve(m.result!));
        return;
      }
      if (m.type === "error") {
        lastChildError = m.message || "IMAP child failed";
        finish(() => reject(new Error(lastChildError!)));
      }
    });

    child.on("error", (err) => {
      finish(() => reject(err));
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      finish(() =>
        reject(
          new Error(
            lastChildError ||
              (signal
                ? `IMAP child killed (${signal})`
                : `IMAP child exited (${code ?? "?"})`),
          ),
        ),
      );
    });
  });
}
