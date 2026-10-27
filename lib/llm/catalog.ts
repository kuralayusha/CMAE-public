/**
 * Model picker data: provider → family → model, plus our recommendations.
 * Pure module (no DB / server-only), shared by the Settings page and the
 * onboarding wizard. The live OpenRouter catalog decides what exists; this
 * file only decides how it is grouped and what we suggest.
 */

import type { OpenRouterModel } from "./openrouter";
import type { Effort, ModelSlot } from "./slots";

export type Provider = {
  /** OpenRouter slug prefix, e.g. `anthropic`. */
  id: string;
  /** Brand name shown in the first dropdown (not translated). */
  label: string;
};

/** The companies a normal user can pick from. Anything else is a custom slug. */
export const PROVIDERS: readonly Provider[] = [
  { id: "anthropic", label: "Anthropic (Claude)" },
  { id: "openai", label: "OpenAI (GPT)" },
  { id: "google", label: "Google (Gemini)" },
  { id: "x-ai", label: "xAI (Grok)" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "mistralai", label: "Mistral" },
  { id: "qwen", label: "Alibaba (Qwen)" },
  { id: "moonshotai", label: "Moonshot (Kimi)" },
  { id: "z-ai", label: "Z.ai (GLM)" },
];

export function providerOf(modelId: string): Provider | null {
  const prefix = modelId.split("/")[0] ?? "";
  return PROVIDERS.find((p) => p.id === prefix) ?? null;
}

/**
 * "Anthropic: Claude Opus 5.5" → "Claude Opus"; "Google: Gemini 3.5 Flash Lite"
 * → "Gemini Flash Lite". Versions and dates are what changes between releases,
 * the remaining words are the tier the user is actually choosing.
 */
export function familyLabel(name: string): string {
  const label = name
    .replace(/^[^:]+:\s*/, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b[vV]?\d+(\.\d+)*[a-zA-Z]?\b/g, " ")
    .replace(/(?<=[A-Za-z])\d+(\.\d+)*/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[-._]+|[-._]+$/g, ""))
    // dangling size/MoE letters ("A22B" → "A B") and release-stage words
    .filter((w) => w.length > 1 && !/^(preview|exp|experimental|instruct)$/i.test(w))
    .join(" ")
    .trim();
  return label || name.replace(/^[^:]+:\s*/, "");
}

/** Name without the "Provider: " prefix, as shown in the model dropdown. */
export function shortName(name: string): string {
  return name.replace(/^[^:]+:\s*/, "").trim() || name;
}

export const OLDER_FAMILY_KEY = "__older";

export type Family = {
  key: string;
  label: string;
  models: OpenRouterModel[];
  /** The catch-all bucket of superseded models (label is supplied by the UI). */
  older?: boolean;
};

/** A provider's models older than this (vs. its newest release) are "older models". */
const CURRENT_WINDOW_S = 270 * 24 * 3600;

/**
 * Families of one provider, newest first. Releases more than ~9 months behind
 * the provider's newest one fall into a single trailing "older models" family,
 * so the second dropdown shows the current line-up, not the whole history.
 */
export function familiesFor(
  providerId: string,
  catalog: readonly OpenRouterModel[],
): Family[] {
  const mine = catalog.filter((m) => m.id.split("/")[0] === providerId);
  const latest = Math.max(0, ...mine.map((m) => m.created ?? 0));
  const byKey = new Map<string, Family>();
  const older: Family = { key: OLDER_FAMILY_KEY, label: "", models: [], older: true };
  for (const m of mine) {
    if (latest && (m.created ?? 0) < latest - CURRENT_WINDOW_S) {
      older.models.push(m);
      continue;
    }
    const label = familyLabel(m.name);
    const key = label.toLowerCase();
    const fam = byKey.get(key) ?? { key, label, models: [] };
    fam.models.push(m);
    byKey.set(key, fam);
  }
  const newest = (f: Family) => f.models[0]?.created ?? 0;
  const byNewest = (a: OpenRouterModel, b: OpenRouterModel) =>
    (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id);
  for (const f of [...byKey.values(), older]) f.models.sort(byNewest);
  const out = [...byKey.values()].sort((a, b) => newest(b) - newest(a));
  if (older.models.length) out.push(older);
  return out;
}

export function familyOfModel(
  modelId: string,
  catalog: readonly OpenRouterModel[],
): Family | null {
  const providerId = modelId.split("/")[0] ?? "";
  return familiesFor(providerId, catalog).find((f) => f.models.some((m) => m.id === modelId)) ?? null;
}

export type Recommendation = { model: string; effort: Effort | "" };

/**
 * Per provider: a cheap model for bulk work and a thinking model for writing.
 * Picked from the OpenRouter catalog of 2026-10-27 (tier, price, efforts the
 * model accepts); a recommendation whose model has left the catalog is simply
 * not offered (see {@link recommendationFor}).
 */
export const RECOMMENDED: Readonly<
  Record<string, Readonly<Record<ModelSlot, Recommendation>>>
> = {
  anthropic: {
    fast: { model: "anthropic/claude-haiku-5.5", effort: "" },
    smart: { model: "anthropic/claude-sonnet-5.5", effort: "medium" },
  },
  openai: {
    fast: { model: "openai/gpt-6-luna", effort: "low" },
    smart: { model: "openai/gpt-6.1-terra", effort: "medium" },
  },
  google: {
    fast: { model: "google/gemini-3.5-flash-lite", effort: "minimal" },
    smart: { model: "google/gemini-3.8-flash", effort: "medium" },
  },
  "x-ai": {
    fast: { model: "x-ai/grok-4.3", effort: "low" },
    smart: { model: "x-ai/grok-4.7", effort: "medium" },
  },
  deepseek: {
    fast: { model: "deepseek/deepseek-v4.1-flash", effort: "low" },
    smart: { model: "deepseek/deepseek-v4-pro-0813", effort: "high" },
  },
  mistralai: {
    fast: { model: "mistralai/mistral-small-2603", effort: "none" },
    smart: { model: "mistralai/mistral-large-4-0", effort: "high" },
  },
  qwen: {
    fast: { model: "qwen/qwen3.8-flash", effort: "" },
    smart: { model: "qwen/qwen3.8-max-0902", effort: "medium" },
  },
  moonshotai: {
    fast: { model: "moonshotai/kimi-k2.6", effort: "" },
    smart: { model: "moonshotai/kimi-k3.1-pro", effort: "high" },
  },
  "z-ai": {
    fast: { model: "z-ai/glm-5.3-flash", effort: "low" },
    smart: { model: "z-ai/glm-5.3-prime", effort: "high" },
  },
};

/** The suggestion for a provider+slot, only if the model is in the catalog and accepts the effort. */
export function recommendationFor(
  providerId: string,
  slot: ModelSlot,
  catalog: readonly OpenRouterModel[] | null,
): Recommendation | null {
  const rec = RECOMMENDED[providerId]?.[slot];
  if (!rec) return null;
  if (!catalog) return rec;
  const m = catalog.find((c) => c.id === rec.model);
  if (!m) return null;
  return { model: rec.model, effort: effortFor(m, rec.effort) };
}

/** Keep `effort` only if the model accepts it ("" = model default is always fine). */
export function effortFor(m: OpenRouterModel | undefined, effort: Effort | ""): Effort | "" {
  if (!effort || !m?.efforts) return "";
  return (m.efforts as string[]).includes(effort) ? effort : "";
}
