/**
 * promptWithUsage — the ONLY place that talks to the model API (a test
 * enforces this). Adds usage measurement + the response cache around one
 * OpenRouter chat completion (lib/llm/openrouter.ts).
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 * OpenRouter returns `usage` (tokens + `cost`) on every response. Token
 * buckets are mapped to the schema the Cursor era used so old and new rows
 * aggregate together: `inputTokens` is the UNCACHED input
 * (`prompt_tokens − cached − cache_write`), cache buckets are separate and
 * `reasoningTokens` is a subset of `outputTokens`. Cost is the amount
 * OpenRouter reports (credits charged + upstream provider cost for BYOK);
 * only when it is absent do we fall back to the price table. Absent usage →
 * `usage_missing = 1` (never zeros as truth).
 *
 * ── Cancel / timeout ───────────────────────────────────────────────────────
 * Unlike the old SDK call, the request is a real `fetch`: a timeout or a lost
 * cancel race aborts it. An aborted call has no usage to read, so it is
 * recorded as `timeout` / `canceled` with `usage_missing = 1`.
 */

import { openRouterChat, type OpenRouterChatResult, type OpenRouterUsage } from "../llm/openrouter";
import { cacheKey } from "./cache-key";
import { isCacheableFeature, type AiFeature, type SyncMode } from "./features";
import { computeCostMicroUsd, EMBEDDED_PRICES, selectPrice } from "./pricing";
import { currentUsageRunId } from "./run-context";
import type { TokenCounts, UsageBackend, UsageEvent, UsageStatus } from "./types";

export type PromptWithUsageInput = {
  feature: AiFeature;
  syncMode?: SyncMode;
  /**
   * UI-level run id (sync job / research job / translate batch). Falls back to
   * AsyncLocalStorage (`withUsageRun`). Never invented per AI call.
   */
  runId?: string | null;
  /** Skip the response-cache read (hard sync); the fresh result still replaces the entry. */
  bypassCache?: boolean;
  /** OpenRouter slug, e.g. `anthropic/claude-sonnet-5.5`. */
  model: string;
  /** Bump when the prompt template changes; part of the cache key. */
  promptVersion?: string | number;
  prompt: string;
  /** OpenRouter API key. */
  apiKey: string;
  timeoutMs?: number;
  timeoutError?: () => Error;
  emptyError?: (status: string) => Error;
  /** Rejects when the caller cancels (e.g. research `whenJobAborted`). */
  cancelRace?: Promise<never>;
  /** Overrides the registered backend (tests). */
  backend?: UsageBackend | null;
  /** Transport override (tests). */
  fetchImpl?: typeof fetch;
};

export type PromptWithUsageResult = {
  text: string;
  /** null when the API reported no usage (usage_missing) or on a cache hit. */
  usage: TokenCounts | null;
  cached: boolean;
  costMicroUsd: number;
  durationMs: number;
};

export class LlmTimeoutError extends Error {
  constructor(seconds: number) {
    super(`LLM timeout after ${seconds}s`);
    this.name = "LlmTimeoutError";
  }
}

let registeredBackend: UsageBackend | null = null;

/** DB-backed persistence is registered by lib/ai-usage/index.ts (never by llm-core). */
export function setUsageBackend(backend: UsageBackend | null): void {
  registeredBackend = backend;
}

const ZERO: TokenCounts = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

function toCounts(u: OpenRouterUsage | null | undefined): TokenCounts | null {
  if (!u) return null;
  return {
    inputTokens: Math.max(0, u.promptTokens - u.cachedTokens - u.cacheWriteTokens),
    outputTokens: u.completionTokens,
    cacheReadTokens: u.cachedTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    reasoningTokens: u.reasoningTokens,
  };
}

/**
 * Micro-USD: what OpenRouter reported, else the price table, else 0.
 *
 * `cost` is what the OpenRouter account was charged, and it is what the
 * OpenRouter dashboard sums. Normal requests ALSO carry
 * `cost_details.upstream_inference_cost`, which is (about) the same money seen
 * from the provider's side — adding it double-counts (verified: a 20-call
 * translation summed to exactly 2× the dashboard). Only a BYOK request has a
 * genuinely separate provider bill: `cost` is then just OpenRouter's small fee
 * (~5%, or 0 within the free monthly allowance) while upstream is the real
 * spend, so upstream ≫ cost. Add it only in that case.
 */
export function openRouterCostUsd(u: OpenRouterUsage): number | null {
  if (u.costUsd == null) return null;
  const byok = u.upstreamCostUsd > u.costUsd * 2;
  return byok ? u.costUsd + u.upstreamCostUsd : u.costUsd;
}

function costOf(
  u: OpenRouterUsage | null | undefined,
  counts: TokenCounts | null,
  price: ReturnType<typeof selectPrice>,
): number {
  const usd = u ? openRouterCostUsd(u) : null;
  if (usd != null) return Math.round(usd * 1e6);
  return counts && price ? computeCostMicroUsd(counts, price) : 0;
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error("[ai-usage] backend error", err);
  }
}

const AI_USAGE_STAMP = "aiUsage";

/** Usage carried on a thrown LLM error so callers can still meter a failed call. */
export type StampedUsage = {
  usage: TokenCounts | null;
  cached: boolean;
  costMicroUsd: number;
  durationMs: number;
};

export function readStampedUsage(err: unknown): StampedUsage | null {
  if (!err || typeof err !== "object" || !(AI_USAGE_STAMP in err)) return null;
  const v = (err as Record<string, unknown>)[AI_USAGE_STAMP];
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<StampedUsage>;
  if (typeof o.costMicroUsd !== "number" || typeof o.durationMs !== "number") {
    return null;
  }
  return {
    usage: o.usage ?? null,
    cached: Boolean(o.cached),
    costMicroUsd: o.costMicroUsd,
    durationMs: o.durationMs,
  };
}

function stampUsage(err: unknown, usage: StampedUsage): void {
  if (!err || typeof err !== "object") return;
  try {
    Object.defineProperty(err, AI_USAGE_STAMP, { value: usage });
  } catch {
    /* frozen error */
  }
}

export async function promptWithUsage(
  input: PromptWithUsageInput,
): Promise<PromptWithUsageResult> {
  const backend = input.backend === undefined ? registeredBackend : input.backend;
  const model = input.model;
  const table = (() => {
    try {
      return backend?.priceTable?.() ?? EMBEDDED_PRICES;
    } catch {
      return EMBEDDED_PRICES;
    }
  })();
  const priceAt = (iso: string) => selectPrice(table, model, iso);
  const cacheable = isCacheableFeature(input.feature);
  const key = cacheable
    ? cacheKey({
        model,
        feature: input.feature,
        promptVersion: input.promptVersion,
        prompt: input.prompt,
      })
    : null;

  const baseEvent = (status: UsageStatus, durationMs: number) => {
    const ts = new Date().toISOString();
    return {
      eventId: globalThis.crypto.randomUUID(),
      ts,
      feature: input.feature,
      syncMode: input.syncMode ?? null,
      runId: input.runId ?? currentUsageRunId() ?? null,
      model,
      priceVersion: table.version,
      status,
      durationMs,
    };
  };

  // 1) response cache read
  if (key && !input.bypassCache && backend?.cacheGet) {
    let hit = null;
    try {
      hit = backend.cacheGet(key, { feature: input.feature, now: Date.now() });
    } catch (err) {
      console.error("[ai-usage] cache read failed", err);
    }
    if (hit) {
      const ev: UsageEvent = {
        ...baseEvent("cache_hit", 0),
        tokens: { ...ZERO },
        costMicroUsd: 0,
        usageMissing: false,
        cacheHit: true,
        savedInputTokens: hit.origInputTokens,
        savedCostMicroUsd: hit.origCostMicroUsd,
      };
      safe(() => backend.record(ev));
      return {
        text: hit.response,
        usage: null,
        cached: true,
        costMicroUsd: 0,
        durationMs: 0,
      };
    }
  }

  // 2) real call
  const started = Date.now();
  const timeoutMs = input.timeoutMs;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let outcome: "timeout" | "canceled" | null = null;

  type Settled =
    | { ok: true; result: OpenRouterChatResult }
    | { ok: false; err: unknown };

  const finalize = (s: Settled) => {
    const durationMs = Date.now() - started;
    if (!backend) return;
    let status: UsageStatus;
    let counts: TokenCounts | null = null;
    let text: string | null = null;
    if (s.ok) {
      counts = toCounts(s.result.usage);
      const failed = !s.result.text;
      text = failed ? null : s.result.text;
      status = outcome ?? (failed ? "error" : "ok");
    } else {
      status = outcome ?? "error";
    }
    const usageMissing = counts === null;
    const tokens = counts ?? { ...ZERO };
    const cost = costOf(
      s.ok ? s.result.usage : null,
      counts,
      priceAt(new Date().toISOString()),
    );
    const ev: UsageEvent = {
      ...baseEvent(status, durationMs),
      tokens,
      costMicroUsd: cost,
      usageMissing,
      cacheHit: false,
      savedInputTokens: 0,
      savedCostMicroUsd: 0,
    };
    safe(() => backend.record(ev));
    if (key && text && backend.cachePut) {
      safe(() =>
        backend.cachePut!({
          key,
          feature: input.feature,
          model,
          promptVersion: String(input.promptVersion ?? "0"),
          response: text!,
          origInputTokens: tokens.inputTokens + tokens.cacheReadTokens,
          origCostMicroUsd: cost,
          now: Date.now(),
        }),
      );
    }
  };

  const controller = new AbortController();
  const call = openRouterChat({
    apiKey: input.apiKey,
    model,
    prompt: input.prompt,
    signal: controller.signal,
    fetchImpl: input.fetchImpl,
  });
  const done: Promise<Settled> = call.then(
    (result) => {
      const s: Settled = { ok: true, result };
      finalize(s);
      return s;
    },
    (err) => {
      const s: Settled = { ok: false, err };
      finalize(s);
      return s;
    },
  );

  const racers: Promise<Settled>[] = [done];
  if (timeoutMs !== undefined) {
    racers.push(
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          outcome = "timeout";
          controller.abort();
          reject(
            input.timeoutError?.() ??
              new LlmTimeoutError(Math.round(timeoutMs / 1000)),
          );
        }, timeoutMs);
      }),
    );
  }
  if (input.cancelRace) {
    racers.push(
      input.cancelRace.catch((err) => {
        outcome ??= "canceled";
        controller.abort();
        throw err;
      }) as Promise<never>,
    );
  }

  let settled: Settled;
  try {
    settled = await Promise.race(racers);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
  if (!settled.ok) {
    stampUsage(settled.err, {
      usage: null,
      cached: false,
      costMicroUsd: 0,
      durationMs: Date.now() - started,
    });
    throw settled.err;
  }
  const result = settled.result;
  const counts = toCounts(result.usage);
  const costMicroUsd = costOf(result.usage, counts, priceAt(new Date().toISOString()));
  if (!result.text) {
    const status = String(result.finishReason ?? "empty");
    const err =
      input.emptyError?.(status) ?? new Error(`LLM returned no result (${status})`);
    stampUsage(err, {
      usage: counts,
      cached: false,
      costMicroUsd,
      durationMs: Date.now() - started,
    });
    throw err;
  }
  return {
    text: result.text,
    usage: counts,
    cached: false,
    costMicroUsd,
    durationMs: Date.now() - started,
  };
}
