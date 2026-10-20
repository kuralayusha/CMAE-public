/**
 * Dedicated IMAP IDLE connection (All Mail, else INBOX).
 * maxIdleTime ~25 min; exists → requestSync(reason: idle) with engine debounce.
 * Separate from sync/drafts connection (process max 2).
 */

import { ImapFlow } from "imapflow";
import { getFencingTokens } from "@/lib/db/app-meta";
import { isOnboardingComplete } from "@/lib/onboarding/status";
import { getGmailCredentials } from "@/lib/settings/service";
import { isAutoSyncBlockedByAuth as authBlockedAt } from "@/lib/sync/credentials";
import { trackImapConnection, getImapConnectionCount } from "./imap-connections";

function autoSyncBlocked(): boolean {
  try {
    return authBlockedAt(getFencingTokens().credentialsVersion);
  } catch {
    return false;
  }
}

/** Lazy import to avoid cycle with sync/engine (which pauses IDLE). */
async function triggerIdleSync(): Promise<void> {
  if (autoSyncBlocked()) return;
  const { requestSync } = await import("@/lib/sync/engine");
  requestSync({ reason: "idle", mode: "incremental" });
}

const GMAIL_HOST = "imap.gmail.com";
const GMAIL_PORT = 993;
const MAX_IDLE_MS = 25 * 60 * 1000;
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000;

type IdleStatus = {
  running: boolean;
  paused: boolean;
  mailbox: string | null;
  usingAllMail: boolean;
  lastExistsAt: string | null;
  lastError: string | null;
  reconnectAttempt: number;
  connectionHeld: boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __cmaeImapIdle: {
    status: IdleStatus;
    client: ImapFlow | null;
    loopAbort: AbortController | null;
    reconnectTimer: ReturnType<typeof setTimeout> | null;
    generation: number;
  } | undefined;
}

function state() {
  if (!globalThis.__cmaeImapIdle) {
    globalThis.__cmaeImapIdle = {
      status: {
        running: false,
        paused: false,
        mailbox: null,
        usingAllMail: false,
        lastExistsAt: null,
        lastError: null,
        reconnectAttempt: 0,
        connectionHeld: false,
      },
      client: null,
      loopAbort: null,
      reconnectTimer: null,
      generation: 0,
    };
  }
  return globalThis.__cmaeImapIdle;
}

export function getIdleWatcherStatus(): IdleStatus & {
  imapConnections: number;
} {
  const s = state().status;
  return { ...s, imapConnections: getImapConnectionCount() };
}

function killClient(client: ImapFlow | null) {
  if (!client) return;
  try {
    client.close();
  } catch {
    /* already closed */
  }
}

async function findAllMailPath(client: ImapFlow): Promise<string | null> {
  const list = await client.list();
  const hit = list.find((m) => {
    const su = (m.specialUse || "").toLowerCase().replace(/^\\/, "");
    return su === "all";
  });
  if (hit?.path) return hit.path;
  const byName = list.find(
    (m) => /all\s*mail/i.test(m.path) || /all\s*mail/i.test(m.name || ""),
  );
  return byName?.path ?? null;
}

function clearReconnectTimer() {
  const s = state();
  if (s.reconnectTimer) {
    clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
  }
}

async function releaseClient(): Promise<void> {
  const s = state();
  const client = s.client;
  s.client = null;
  if (s.status.connectionHeld) {
    trackImapConnection(-1);
    s.status.connectionHeld = false;
  }
  if (!client) return;
  try {
    await client.logout();
  } catch {
    killClient(client);
  }
}

function scheduleReconnect(delayMs?: number) {
  const s = state();
  if (s.status.paused || !s.status.running) return;
  clearReconnectTimer();
  const attempt = s.status.reconnectAttempt;
  const delay =
    delayMs ??
    Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * Math.pow(2, Math.min(attempt, 6)),
    );
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    void runIdleLoop();
  }, delay);
  if (
    typeof s.reconnectTimer === "object" &&
    s.reconnectTimer &&
    "unref" in s.reconnectTimer
  ) {
    s.reconnectTimer.unref();
  }
}

async function runIdleLoop(): Promise<void> {
  const s = state();
  if (!s.status.running || s.status.paused) return;
  if (!isOnboardingComplete() || autoSyncBlocked()) {
    scheduleReconnect(30_000);
    return;
  }

  const creds = getGmailCredentials();
  if (!creds?.address || !creds.appPassword) {
    s.status.lastError = "missing_credentials";
    scheduleReconnect(60_000);
    return;
  }

  // Don't start IDLE if another connection already holds both slots.
  if (getImapConnectionCount() >= 2) {
    scheduleReconnect(15_000);
    return;
  }

  clearReconnectTimer();
  s.generation += 1;
  const gen = s.generation;
  if (s.loopAbort) {
    try {
      s.loopAbort.abort();
    } catch {
      /* ignore */
    }
  }
  await releaseClient();

  const abort = new AbortController();
  s.loopAbort = abort;

  const client = new ImapFlow({
    host: GMAIL_HOST,
    port: GMAIL_PORT,
    secure: true,
    auth: { user: creds.address, pass: creds.appPassword },
    logger: false,
    socketTimeout: 300_000,
    greetingTimeout: 15_000,
    maxIdleTime: MAX_IDLE_MS,
    disableAutoIdle: true,
  });

  const onExists = () => {
    if (gen !== state().generation) return;
    s.status.lastExistsAt = new Date().toISOString();
    void triggerIdleSync().catch((err) => {
      console.error("[imap-idle] requestSync failed", err);
    });
  };

  const onCloseOrError = (err?: Error) => {
    if (gen !== state().generation) return;
    if (err) {
      s.status.lastError = err.message || String(err);
    }
  };

  try {
    await client.connect();
    if (abort.signal.aborted || gen !== state().generation) {
      killClient(client);
      return;
    }

    trackImapConnection(1);
    s.status.connectionHeld = true;
    s.client = client;
    s.status.reconnectAttempt = 0;
    s.status.lastError = null;

    const allPath = await findAllMailPath(client);
    const mailbox = allPath || "INBOX";
    s.status.mailbox = mailbox;
    s.status.usingAllMail = Boolean(allPath);

    await client.mailboxOpen(mailbox);
    client.on("exists", onExists);
    client.on("close", () => onCloseOrError());
    client.on("error", (err: Error) => onCloseOrError(err));

    while (
      s.status.running &&
      !s.status.paused &&
      !abort.signal.aborted &&
      gen === state().generation &&
      client.usable
    ) {
      try {
        await client.idle();
      } catch (err) {
        if (abort.signal.aborted || gen !== state().generation) break;
        s.status.lastError =
          err instanceof Error ? err.message : String(err);
        break;
      }
      // maxIdleTime elapsed — briefly leave IDLE and re-enter.
    }
  } catch (err) {
    s.status.lastError = err instanceof Error ? err.message : String(err);
    s.status.reconnectAttempt += 1;
  } finally {
    try {
      client.off("exists", onExists);
    } catch {
      /* ignore */
    }
    if (s.client === client) {
      await releaseClient();
    } else {
      killClient(client);
    }
  }

  if (s.status.running && !s.status.paused && gen === state().generation) {
    s.status.reconnectAttempt += 1;
    scheduleReconnect();
  }
}

/** Start IDLE loop (HMR-safe; no-op if already running). */
export function startIdleWatcher(): void {
  const s = state();
  if (s.status.running && !s.status.paused) return;
  s.status.running = true;
  s.status.paused = false;
  void runIdleLoop();
}

/** Soft-pause (e.g. while sync/drafts hold the work connection). */
export function pauseIdleWatcher(): void {
  const s = state();
  if (!s.status.running) return;
  s.status.paused = true;
  clearReconnectTimer();
  if (s.loopAbort) {
    try {
      s.loopAbort.abort();
    } catch {
      /* ignore */
    }
  }
  s.generation += 1;
  void releaseClient();
}

/** Resume after pause; reconnects. */
export function resumeIdleWatcher(): void {
  const s = state();
  if (!s.status.running) {
    startIdleWatcher();
    return;
  }
  s.status.paused = false;
  s.status.reconnectAttempt = 0;
  void runIdleLoop();
}

/** Hard stop (onboarding reset / logout). */
export function stopIdleWatcher(): void {
  const s = state();
  s.status.running = false;
  s.status.paused = false;
  clearReconnectTimer();
  if (s.loopAbort) {
    try {
      s.loopAbort.abort();
    } catch {
      /* ignore */
    }
  }
  s.generation += 1;
  void releaseClient();
}

/** Sleep/network wake: drop socket and reconnect. */
export function reconnectIdleWatcher(): void {
  const s = state();
  if (!s.status.running) return;
  s.status.paused = false;
  s.status.reconnectAttempt = 0;
  clearReconnectTimer();
  if (s.loopAbort) {
    try {
      s.loopAbort.abort();
    } catch {
      /* ignore */
    }
  }
  s.generation += 1;
  void releaseClient().then(() => {
    scheduleReconnect(1_000);
  });
}
