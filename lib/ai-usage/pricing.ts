/**
 * Model price table + cost formula. Pure (no DB): the DB-backed cache of the
 * remote table lives in store.ts.
 *
 * Rates are USD per 1M tokens, which equals micro-USD per token — so
 * `tokens * rate` is already micro-USD and the stored cost is an integer.
 *
 * Token semantics (kept from the Cursor era so old and new rows add up):
 * `inputTokens` is the UNCACHED input, `cacheReadTokens` / `cacheWriteTokens`
 * are separate buckets, and `reasoningTokens` is a SUBSET of `outputTokens`
 * (reported, never billed again). OpenRouter's `prompt_tokens` includes cached
 * tokens, so lib/ai-usage/call.ts subtracts them when mapping.
 */

import type { TokenCounts } from "./types";

export type ModelPrice = {
  model: string;
  /** USD per 1M tokens */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** ISO date; the price applies to calls at/after this instant */
  validFrom: string;
};

export type PriceTable = {
  /** Stored with every usage row so old rows keep the price of their day. */
  version: string;
  prices: ModelPrice[];
};

/**
 * Model of every event recorded before the OpenRouter migration (Cursor SDK).
 * Old rows are backfilled with it (migration 017); the price row keeps their
 * historical cost recomputable.
 */
export const LEGACY_MODEL = "composer-2.5";

/**
 * OpenRouter reports the charged cost itself (`usage.cost`), so this table is
 * only a fallback for responses without one. Unknown models have no price →
 * cost 0 with the token counts kept (never a guessed price).
 */
export const EMBEDDED_PRICES: PriceTable = {
  version: "embedded-2026-10-27",
  prices: [
    {
      model: LEGACY_MODEL,
      input: 0.5,
      cacheRead: 0.2,
      cacheWrite: 0,
      output: 2.5,
      validFrom: "2000-01-01T00:00:00Z",
    },
  ],
};

/** Latest price of `model` with validFrom <= `atIso`; null for an unknown model. */
export function selectPrice(
  table: PriceTable,
  model: string,
  atIso: string = new Date().toISOString(),
): ModelPrice | null {
  const at = Date.parse(atIso);
  return (
    table.prices
      .filter((p) => p.model === model && Date.parse(p.validFrom) <= at)
      .sort((a, b) => Date.parse(b.validFrom) - Date.parse(a.validFrom))[0] ?? null
  );
}

/** Integer micro-USD. Reasoning tokens are already inside `outputTokens`. */
export function computeCostMicroUsd(
  usage: Pick<
    TokenCounts,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
  >,
  price: Pick<ModelPrice, "input" | "cacheRead" | "cacheWrite" | "output">,
): number {
  const micro =
    usage.inputTokens * price.input +
    usage.cacheReadTokens * price.cacheRead +
    usage.cacheWriteTokens * price.cacheWrite +
    usage.outputTokens * price.output;
  return Math.round(micro);
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/**
 * Validate a remote table (`{version, prices:[{model_id|model, input,
 * cache_read, cache_write, output, valid_from}]}`); null when unusable.
 */
export function parsePriceTable(raw: unknown): PriceTable | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  // Ingest labels reject '+'; normalize ISO offsets so remote versions stay safe.
  const version = typeof o.version === "string"
    ? o.version.trim().replace(/\+00:00$/, "Z").replace(/\+/g, "p")
    : "";
  if (!version || !Array.isArray(o.prices)) return null;
  const prices: ModelPrice[] = [];
  for (const row of o.prices) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const model = String(r.model_id ?? r.model ?? "").trim();
    const input = num(r.input);
    const cacheRead = num(r.cache_read ?? r.cacheRead);
    const cacheWrite = num(r.cache_write ?? r.cacheWrite ?? 0);
    const output = num(r.output);
    const validFrom = String(r.valid_from ?? r.validFrom ?? "2000-01-01T00:00:00Z");
    if (
      !model ||
      input == null ||
      cacheRead == null ||
      cacheWrite == null ||
      output == null ||
      !Number.isFinite(Date.parse(validFrom))
    ) {
      continue;
    }
    prices.push({ model, input, cacheRead, cacheWrite, output, validFrom });
  }
  if (!prices.length) return null;
  return { version, prices };
}
