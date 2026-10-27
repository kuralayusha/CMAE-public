/**
 * SQLite-backed UsageBackend + price-table cache + telemetry consent flag.
 * All functions take an optional `db` (tests); default is the live handle.
 */

import type Database from "better-sqlite3";
import crypto from "node:crypto";
import { getAppMeta, setAppMeta } from "@/lib/db/app-meta";
import { getSqlite } from "@/lib/db/client";
import { cacheGet, cachePut } from "./cache";
import { usageConfig } from "./config";
import {
  EMBEDDED_PRICES,
  LEGACY_MODEL,
  parsePriceTable,
  type PriceTable,
} from "./pricing";
import type { UsageBackend, UsageEvent } from "./types";

const MAX_UNSENT_ROWS = 20_000;
const PRICE_REFRESH_MS = 24 * 60 * 60 * 1000;

export function insertUsageEvent(db: Database.Database, e: UsageEvent): void {
  db.prepare(
    `INSERT OR IGNORE INTO ai_usage_events
      (event_id, ts, feature, sync_mode, run_id, model, price_version,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       reasoning_tokens, cost_micro_usd, duration_ms, status, usage_missing,
       cache_hit, saved_input_tokens, saved_cost_micro_usd, uploaded_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
  ).run(
    e.eventId,
    e.ts,
    e.feature,
    e.syncMode,
    e.runId,
    e.model,
    e.priceVersion,
    e.tokens.inputTokens,
    e.tokens.outputTokens,
    e.tokens.cacheReadTokens,
    e.tokens.cacheWriteTokens,
    e.tokens.reasoningTokens,
    e.costMicroUsd,
    e.durationMs,
    e.status,
    e.usageMissing ? 1 : 0,
    e.cacheHit ? 1 : 0,
    e.savedInputTokens,
    e.savedCostMicroUsd,
  );
}

/** Keep the unsent queue bounded and drop long-uploaded rows. */
export function pruneUsageEvents(db: Database.Database): void {
  db.prepare(
    `DELETE FROM ai_usage_events
     WHERE uploaded_at IS NOT NULL AND uploaded_at < ?`,
  ).run(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString());
  db.prepare(
    `DELETE FROM ai_usage_events WHERE event_id IN (
       SELECT event_id FROM ai_usage_events WHERE uploaded_at IS NULL
       ORDER BY ts DESC LIMIT -1 OFFSET ?)`,
  ).run(MAX_UNSENT_ROWS);
}

/**
 * Upload consent. Demo builds always share anonymous counters, so a stored
 * "off" is healed back to on. A missing row/column also counts as on.
 */
export function isTelemetryEnabled(db: Database.Database = getSqlite()): boolean {
  try {
    const row = db
      .prepare(`SELECT usage_telemetry_enabled AS v FROM settings WHERE id = 1`)
      .get() as { v: number } | undefined;
    if (!row || row.v === 0) setTelemetryEnabled(true, db);
  } catch {
    /* column missing during migration */
  }
  return true;
}

export function setTelemetryEnabled(
  enabled: boolean,
  db: Database.Database = getSqlite(),
): void {
  // Demo: this switch cannot turn sharing off. `enabled` is ignored.
  void enabled;
  db.prepare(
    `INSERT INTO settings (id, usage_telemetry_enabled) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET usage_telemetry_enabled = excluded.usage_telemetry_enabled`,
  ).run(1);
}

const MAX_IMPORTED_CALLS = 400;

function finiteToken(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}

/**
 * Persist usage measured on another host (the Vercel translation proxy) into
 * this machine's ai_usage_events. Counters only — callers must not pass text.
 */
export function recordImportedTranslateUsage(
  runId: string,
  calls: unknown,
  db: Database.Database = getSqlite(),
): number {
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > MAX_IMPORTED_CALLS) {
    return 0;
  }
  const id = runId.trim().slice(0, 80);
  if (!id) return 0;
  const backend = createDbBackend(() => db);
  const priceVersion = priceTableFromDb(db).version;
  const ts = new Date().toISOString();
  let n = 0;
  for (const raw of calls) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (c.feature !== "i18n.translate") continue;
    const model =
      typeof c.model === "string" && c.model.trim()
        ? c.model.trim().slice(0, 80)
        : LEGACY_MODEL;
    const cached = c.cached === true;
    backend.record({
      eventId: crypto.randomUUID(),
      ts,
      feature: "i18n.translate",
      syncMode: null,
      runId: id,
      model,
      priceVersion,
      tokens: {
        inputTokens: finiteToken(c.inputTokens),
        outputTokens: finiteToken(c.outputTokens),
        cacheReadTokens: finiteToken(c.cacheReadTokens),
        cacheWriteTokens: finiteToken(c.cacheWriteTokens),
        reasoningTokens: finiteToken(c.reasoningTokens),
      },
      costMicroUsd: finiteToken(c.costMicroUsd),
      durationMs: finiteToken(c.durationMs),
      status: cached ? "cache_hit" : "ok",
      usageMissing: c.usageMissing === true && !cached,
      cacheHit: cached,
      savedInputTokens: 0,
      savedCostMicroUsd: 0,
    });
    n += 1;
  }
  return n;
}

let recordsSinceKick = 0;
let onRecorded: (() => void) | null = null;
/** uploader registers a nudge so a burst of rows triggers an early upload. */
export function setOnRecorded(fn: (() => void) | null): void {
  onRecorded = fn;
}

export function priceTableFromDb(db: Database.Database = getSqlite()): PriceTable {
  try {
    const raw = getAppMeta("ai_prices_json", db);
    if (raw) {
      const parsed = parsePriceTable(JSON.parse(raw));
      if (parsed) return parsed;
    }
  } catch {
    /* fall back */
  }
  return EMBEDDED_PRICES;
}

/**
 * Daily refresh from CMAE_USAGE_PRICES_URL; embedded defaults stay the
 * fallback on any failure. Never throws.
 */
export async function refreshPricesIfDue(
  opts: { db?: Database.Database; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<boolean> {
  try {
    const db = opts.db ?? getSqlite();
    const cfg = usageConfig();
    if (!cfg.pricesUrl) return false;
    const now = opts.now ?? Date.now();
    const last = Number(getAppMeta("ai_prices_fetched_at", db)) || 0;
    if (now - last < PRICE_REFRESH_MS) return false;
    const f = opts.fetchImpl ?? fetch;
    const res = await f(cfg.pricesUrl, {
      headers: cfg.anonKey
        ? { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}` }
        : {},
      signal: AbortSignal.timeout(10_000),
    });
    // Count the attempt either way so a dead endpoint isn't hammered.
    setAppMeta("ai_prices_fetched_at", String(now), db);
    if (!res.ok) return false;
    const table = parsePriceTable(await res.json());
    if (!table) return false;
    setAppMeta("ai_prices_json", JSON.stringify(table), db);
    return true;
  } catch {
    return false;
  }
}

export function createDbBackend(getDb: () => Database.Database = getSqlite): UsageBackend {
  return {
    record(event) {
      const db = getDb();
      insertUsageEvent(db, event);
      recordsSinceKick += 1;
      if (recordsSinceKick >= 50) {
        recordsSinceKick = 0;
        onRecorded?.();
      }
    },
    cacheGet(key, ctx) {
      return cacheGet(getDb(), key, ctx.now);
    },
    cachePut(entry) {
      cachePut(getDb(), entry);
    },
    priceTable() {
      return priceTableFromDb(getDb());
    },
  };
}
