/**
 * ai_response_cache — local-only prompt→response cache (never uploaded).
 * TTL 30 days, ~50 MB total, LRU by last_hit_at. Policy (which features may be
 * cached) lives in features.ts; call.ts only reaches this for allowed ones.
 */

import type Database from "better-sqlite3";
import { isCacheableFeature, type AiFeature } from "./features";
import type { CachedResponse } from "./types";

export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CACHE_MAX_BYTES = 50 * 1024 * 1024;
const PRUNE_EVERY_PUTS = 25;
let putsSincePrune = 0;

export function cacheGet(
  db: Database.Database,
  key: string,
  now: number = Date.now(),
): CachedResponse | null {
  const row = db
    .prepare(
      `SELECT response, ttl_at AS ttlAt, orig_input_tokens AS origInputTokens,
              orig_cost_micro_usd AS origCostMicroUsd
       FROM ai_response_cache WHERE key = ?`,
    )
    .get(key) as
    | { response: string; ttlAt: number; origInputTokens: number; origCostMicroUsd: number }
    | undefined;
  if (!row) return null;
  if (row.ttlAt <= now) {
    db.prepare(`DELETE FROM ai_response_cache WHERE key = ?`).run(key);
    return null;
  }
  db.prepare(
    `UPDATE ai_response_cache SET hits = hits + 1, last_hit_at = ? WHERE key = ?`,
  ).run(now, key);
  return {
    response: row.response,
    origInputTokens: row.origInputTokens,
    origCostMicroUsd: row.origCostMicroUsd,
  };
}

/** Returns false (and stores nothing) for features outside the cache policy. */
export function cachePut(
  db: Database.Database,
  entry: {
    key: string;
    feature: AiFeature;
    model: string;
    promptVersion: string;
    response: string;
    origInputTokens: number;
    origCostMicroUsd: number;
    now?: number;
  },
): boolean {
  if (!isCacheableFeature(entry.feature)) return false;
  const now = entry.now ?? Date.now();
  db.prepare(
    `INSERT INTO ai_response_cache
       (key, feature, model, prompt_version, response, bytes, created_at,
        last_hit_at, hits, ttl_at, orig_input_tokens, orig_cost_micro_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       response = excluded.response, bytes = excluded.bytes,
       created_at = excluded.created_at, last_hit_at = excluded.last_hit_at,
       ttl_at = excluded.ttl_at, orig_input_tokens = excluded.orig_input_tokens,
       orig_cost_micro_usd = excluded.orig_cost_micro_usd`,
  ).run(
    entry.key,
    entry.feature,
    entry.model,
    entry.promptVersion,
    entry.response,
    Buffer.byteLength(entry.response, "utf8"),
    now,
    now,
    now + CACHE_TTL_MS,
    entry.origInputTokens,
    entry.origCostMicroUsd,
  );
  putsSincePrune += 1;
  if (putsSincePrune >= PRUNE_EVERY_PUTS) {
    putsSincePrune = 0;
    cachePrune(db, now);
  }
  return true;
}

/** Drop expired rows, then least-recently-hit rows until under the size cap. */
export function cachePrune(
  db: Database.Database,
  now: number = Date.now(),
  maxBytes: number = CACHE_MAX_BYTES,
): void {
  db.prepare(`DELETE FROM ai_response_cache WHERE ttl_at <= ?`).run(now);
  const total = () =>
    (
      db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS n FROM ai_response_cache`).get() as {
        n: number;
      }
    ).n;
  let size = total();
  while (size > maxBytes) {
    const victims = db
      .prepare(
        `SELECT key, bytes FROM ai_response_cache ORDER BY last_hit_at ASC LIMIT 50`,
      )
      .all() as { key: string; bytes: number }[];
    if (!victims.length) break;
    const del = db.prepare(`DELETE FROM ai_response_cache WHERE key = ?`);
    for (const v of victims) {
      del.run(v.key);
      size -= v.bytes;
      if (size <= maxBytes) break;
    }
  }
}

export function cacheClear(db: Database.Database): void {
  db.prepare(`DELETE FROM ai_response_cache`).run();
}
