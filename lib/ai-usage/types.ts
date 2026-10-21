import type { AiFeature, SyncMode } from "./features";

export type TokenCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
};

export type UsageStatus = "ok" | "error" | "timeout" | "canceled" | "cache_hit";

/** One measured AI call. Counters and labels only — never any text. */
export type UsageEvent = {
  eventId: string;
  ts: string;
  feature: AiFeature;
  syncMode: SyncMode | null;
  /**
   * UI-level run (sync job / research job / translate batch). Null when the
   * call is not part of such a run — never equals eventId as a fake stand-in.
   */
  runId: string | null;
  model: string;
  priceVersion: string;
  tokens: TokenCounts;
  costMicroUsd: number;
  durationMs: number;
  status: UsageStatus;
  /** Usage could not be read from the SDK — tokens/cost are NOT zero truth. */
  usageMissing: boolean;
  cacheHit: boolean;
  /** Estimated saving of a cache hit (from the original call). */
  savedInputTokens: number;
  savedCostMicroUsd: number;
};

export type CachedResponse = {
  response: string;
  origInputTokens: number;
  origCostMicroUsd: number;
};

/**
 * Injected persistence. Absent (eval harness) → no caching, no recording, so
 * lib/tracker/llm-core.ts stays free of DB imports.
 */
export type UsageBackend = {
  record(event: UsageEvent): void;
  cacheGet?(key: string, ctx: { feature: AiFeature; now: number }): CachedResponse | null;
  cachePut?(entry: {
    key: string;
    feature: AiFeature;
    model: string;
    promptVersion: string;
    response: string;
    origInputTokens: number;
    origCostMicroUsd: number;
    now: number;
  }): void;
  priceTable?(): import("./pricing").PriceTable;
};
