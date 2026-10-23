/**
 * promptWithUsage — the ONLY place that calls `Agent.prompt` (a test enforces
 * this). Adds usage measurement + the response cache around the SDK call.
 *
 * ── How token usage is read (verified against @cursor/sdk 1.0.37) ──────────
 * `Agent.prompt(message, options)` is implemented as
 *   `agent = Agent.create(options); run = agent.send(message); await run.wait();
 *    agent[Symbol.asyncDispose]()`
 * (see node_modules/@cursor/sdk/dist/esm, `static async prompt`). `run.wait()`
 * returns a `RunResult`, which carries
 *   `usage?: TokenUsage`  — "Cumulative token usage across turns that reported
 *                           it; absent when none did" (dist/esm/run.d.ts).
 * `TokenUsage = {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 * totalTokens, reasoningTokens?}`; the SDK builds it from the local agent's
 * `turn-ended` event via `toTokenUsage/sumTokenUsage`
 * (`totalTokens = input + output + cacheRead + cacheWrite`, so input is the
 * uncached bucket and reasoning is a subset of output).
 * So `RunResult.usage` is read directly — no `agent.getUsage()` and no manual
 * Agent.create/send/wait is needed. `agent.getUsage()` (AgentUsage with
 * `UsageCost.rawCostCents`) exists too but is eventually consistent and would
 * need a second call; we compute cost from our own price table instead.
 * When `usage` is absent we set `usage_missing = true` and never write zeros
 * as truth.
 *
 * Cancel / timeout: `Agent.prompt` has no abort API, so callers race it (timeout
 * and/or a cancel promise). The SDK call keeps running in the background after
 * a lost race; its usage is still recorded when it eventually settles (status
 * `timeout` / `canceled`) because the tokens were spent.
 */

import { Agent } from "@cursor/sdk";
import { cacheKey } from "./cache-key";
import { isCacheableFeature, type AiFeature, type SyncMode } from "./features";
import {
  computeCostMicroUsd,
  DEFAULT_MODEL,
  EMBEDDED_PRICES,
  selectPrice,
} from "./pricing";
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
  model?: string;
  /** Bump when the prompt template changes; part of the cache key. */
  promptVersion?: string | number;
  prompt: string;
  apiKey: string;
  cwd: string;
  timeoutMs?: number;
  timeoutError?: () => Error;
  emptyError?: (status: string) => Error;
  /** Rejects when the caller cancels (e.g. research `whenJobAborted`). */
  cancelRace?: Promise<never>;
  /** Overrides the registered backend (tests). */
  backend?: UsageBackend | null;
};

export type PromptWithUsageResult = {
  text: string;
  /** null when the SDK reported no usage (usage_missing) or on a cache hit. */
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

function toCounts(
  u:
    | {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        reasoningTokens?: number;
      }
    | undefined,
): TokenCounts | null {
  if (!u) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    inputTokens: n(u.inputTokens),
    outputTokens: n(u.outputTokens),
    cacheReadTokens: n(u.cacheReadTokens),
    cacheWriteTokens: n(u.cacheWriteTokens),
    reasoningTokens: n(u.reasoningTokens),
  };
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
  const model = input.model ?? DEFAULT_MODEL;
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
    | { ok: true; result: Awaited<ReturnType<typeof Agent.prompt>> }
    | { ok: false; err: unknown };

  const finalize = (s: Settled) => {
    const durationMs = Date.now() - started;
    if (!backend) return;
    let status: UsageStatus;
    let counts: TokenCounts | null = null;
    let text: string | null = null;
    if (s.ok) {
      counts = toCounts(s.result.usage);
      const failed = s.result.status === "error" || !s.result.result;
      text = failed ? null : String(s.result.result).trim();
      status = outcome ?? (failed ? "error" : "ok");
    } else {
      status = outcome ?? "error";
    }
    const usageMissing = counts === null;
    const tokens = counts ?? { ...ZERO };
    const cost = counts ? computeCostMicroUsd(tokens, priceAt(new Date().toISOString())) : 0;
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

  const call = Agent.prompt(input.prompt, {
    apiKey: input.apiKey,
    model: { id: model },
    local: { cwd: input.cwd },
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
  if (result.status === "error" || !result.result) {
    const status = String(result.status ?? "unknown");
    const err =
      input.emptyError?.(status) ?? new Error(`LLM returned no result (${status})`);
    stampUsage(err, {
      usage: counts,
      cached: false,
      costMicroUsd: counts
        ? computeCostMicroUsd(counts, priceAt(new Date().toISOString()))
        : 0,
      durationMs: Date.now() - started,
    });
    throw err;
  }
  return {
    text: String(result.result).trim(),
    usage: counts,
    cached: false,
    costMicroUsd: counts
      ? computeCostMicroUsd(counts, priceAt(new Date().toISOString()))
      : 0,
    durationMs: Date.now() - started,
  };
}
