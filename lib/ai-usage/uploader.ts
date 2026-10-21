/**
 * Background uploader for ai_usage_events. Sends ONLY counters and labels
 * ({user_id, secret, app_version, platform, events[]}); event_id (client UUID)
 * makes re-sends idempotent on the server. Never throws into sync/research,
 * never blocks them; offline → exponential backoff; skipped when telemetry is
 * disabled or no endpoint is configured.
 */

import type Database from "better-sqlite3";
import { getSqlite } from "@/lib/db/client";
import { loadLocalAppVersion } from "@/lib/version/policy";
import { getAnonId, regenerateAnonId } from "./anon-id";
import { usageConfig } from "./config";
import {
  isTelemetryEnabled,
  pruneUsageEvents,
  refreshPricesIfDue,
  setOnRecorded,
} from "./store";

const BATCH = 200;
const MAX_BATCHES_PER_RUN = 5;
const INTERVAL_MS = 60_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;

type Row = {
  event_id: string;
  ts: string;
  feature: string;
  sync_mode: string | null;
  run_id: string | null;
  model: string;
  price_version: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_micro_usd: number;
  duration_ms: number;
  status: string;
  usage_missing: number;
  cache_hit: number;
  saved_input_tokens: number;
  saved_cost_micro_usd: number;
};

/** Explicit allow-list of wire fields — no text can leak through here. */
function toWire(r: Row) {
  return {
    event_id: r.event_id,
    ts: r.ts,
    feature: r.feature,
    sync_mode: r.sync_mode,
    run_id: r.run_id || null,
    model: r.model,
    price_version: r.price_version,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cache_read_tokens: r.cache_read_tokens,
    cache_write_tokens: r.cache_write_tokens,
    reasoning_tokens: r.reasoning_tokens,
    cost_micro_usd: r.cost_micro_usd,
    duration_ms: r.duration_ms,
    status: r.status,
    usage_missing: r.usage_missing === 1,
    cache_hit: r.cache_hit === 1,
    saved_input_tokens: r.saved_input_tokens,
    saved_cost_micro_usd: r.saved_cost_micro_usd,
  };
}

export type UploadStatus =
  | "disabled"
  | "unconfigured"
  | "backoff"
  | "idle"
  | "ok"
  | "failed";

export type UploadDeps = {
  db?: Database.Database;
  fetchImpl?: typeof fetch;
  now?: () => number;
  config?: { ingestUrl: string; anonKey: string };
  appVersion?: string;
  platform?: string;
  /** anon-id root override (tests) */
  root?: string;
};

const state = { failures: 0, backoffUntil: 0 };

export function resetUploaderState(): void {
  state.failures = 0;
  state.backoffUntil = 0;
}

export function uploaderBackoffUntil(): number {
  return state.backoffUntil;
}

export async function uploadPending(
  deps: UploadDeps = {},
): Promise<{ status: UploadStatus; sent: number }> {
  try {
    const db = deps.db ?? getSqlite();
    const now = deps.now ?? Date.now;
    if (!isTelemetryEnabled(db)) return { status: "disabled", sent: 0 };
    const cfg = deps.config ?? usageConfig();
    if (!cfg.ingestUrl) return { status: "unconfigured", sent: 0 };
    if (now() < state.backoffUntil) return { status: "backoff", sent: 0 };

    const f = deps.fetchImpl ?? fetch;
    const idOpts = deps.db ? { root: deps.root, db } : { root: deps.root };
    let id = getAnonId(idOpts);
    const appVersion = deps.appVersion ?? loadLocalAppVersion();
    const platform = deps.platform ?? process.platform;
    let sent = 0;

    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const rows = db
        .prepare(
          `SELECT event_id, ts, feature, sync_mode, run_id, model, price_version,
                  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                  reasoning_tokens, cost_micro_usd, duration_ms, status,
                  usage_missing, cache_hit, saved_input_tokens, saved_cost_micro_usd
           FROM ai_usage_events WHERE uploaded_at IS NULL
           ORDER BY ts ASC LIMIT ${BATCH}`,
        )
        .all() as Row[];
      if (!rows.length) return { status: sent ? "ok" : "idle", sent };

      const post = () =>
        f(cfg.ingestUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(cfg.anonKey
              ? { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}` }
              : {}),
          },
          body: JSON.stringify({
            user_id: id.userId,
            secret: id.secret,
            app_version: appVersion,
            platform,
            events: rows.map(toWire),
          }),
          signal: AbortSignal.timeout(15_000),
        });

      let res = await post();
      if (res.status === 409) {
        // User-id collision: a different secret owns this id. Mint a new
        // identity; unsent rows carry no user id, so re-keying = re-sending.
        id = regenerateAnonId(id.userId, idOpts);
        res = await post();
      }
      if (!res.ok) {
        state.failures += 1;
        state.backoffUntil =
          now() + Math.min(BACKOFF_BASE_MS * 2 ** (state.failures - 1), BACKOFF_MAX_MS);
        return { status: "failed", sent };
      }

      const stamp = new Date(now()).toISOString();
      const mark = db.prepare(
        `UPDATE ai_usage_events SET uploaded_at = ? WHERE event_id = ?`,
      );
      db.transaction(() => {
        for (const r of rows) mark.run(stamp, r.event_id);
      })();
      sent += rows.length;
      state.failures = 0;
      state.backoffUntil = 0;
      if (rows.length < BATCH) return { status: "ok", sent };
    }
    return { status: "ok", sent };
  } catch {
    // network error / abort / DB hiccup — back off, never propagate
    state.failures += 1;
    state.backoffUntil =
      (deps.now ?? Date.now)() +
      Math.min(BACKOFF_BASE_MS * 2 ** (state.failures - 1), BACKOFF_MAX_MS);
    return { status: "failed", sent: 0 };
  }
}

let started = false;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await refreshPricesIfDue();
    await uploadPending();
    try {
      pruneUsageEvents(getSqlite());
    } catch {
      /* ignore */
    }
  } finally {
    running = false;
  }
}

/** Idempotent, non-blocking. Called from instrumentation.node.ts. */
export function startUsageUploader(): void {
  if (started) return;
  started = true;
  setOnRecorded(() => void tick());
  const first = setTimeout(() => void tick(), 20_000);
  first.unref?.();
  const timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref?.();
}
