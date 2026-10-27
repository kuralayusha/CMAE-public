/**
 * Model slots. Pure module (no DB / server-only imports) so the eval harness
 * and promptWithUsage's callers share one mapping.
 *
 * Two user-configurable slots instead of one model per feature:
 * - fast:  high-volume, structured, repeatable work (triage, identity, events,
 *          signals, translation, link planning, key check)
 * - smart: writing and judgement the user reads (company note, mail drafts,
 *          reviewer, job fit, follow-up mails)
 */

import { AI_FEATURES, type AiFeature } from "@/lib/ai-usage/features";

export const MODEL_SLOTS = ["fast", "smart"] as const;
export type ModelSlot = (typeof MODEL_SLOTS)[number];

/** OpenRouter slugs. Used until the user picks something else in Settings. */
export const DEFAULT_MODELS: Readonly<Record<ModelSlot, string>> = {
  fast: "anthropic/claude-haiku-5.5",
  smart: "anthropic/claude-sonnet-5.5",
};

const SMART_FEATURES: ReadonlySet<AiFeature> = new Set<AiFeature>([
  "research.research",
  "research.writer",
  "research.reviewer",
  "research.jobfit",
  "tracker.followup",
]);

export function slotForFeature(feature: AiFeature): ModelSlot {
  return SMART_FEATURES.has(feature) ? "smart" : "fast";
}

/** Shape check only; the live catalog (GET /models) is the real validator. */
export function isPlausibleModelId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length <= 120 &&
    /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:+-]*$/i.test(id)
  );
}

/**
 * Reasoning effort as OpenRouter's `reasoning.effort` knows it. Which of these
 * a model accepts comes from the live catalog (`supported_efforts`); "" in a
 * choice means "don't send it — the model's own default".
 */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export function isEffort(v: unknown): v is Effort {
  return typeof v === "string" && (EFFORTS as readonly string[]).includes(v);
}

/** A model plus optional reasoning effort ("" = model default). */
export type LlmChoice = { model: string; effort: Effort | "" };

/** Per-feature choices from "detailed mode"; absent feature = follows its slot. */
export type LlmOverrides = Partial<Record<AiFeature, LlmChoice>>;

/** Tolerant parse of the stored JSON: anything malformed is dropped, never thrown. */
export function parseLlmOverrides(raw: unknown): LlmOverrides {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = raw.trim() ? JSON.parse(raw) : null;
    } catch {
      return {};
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: LlmOverrides = {};
  for (const feature of AI_FEATURES) {
    const c = (v as Record<string, unknown>)[feature];
    if (!c || typeof c !== "object") continue;
    const model = (c as { model?: unknown }).model;
    const effort = (c as { effort?: unknown }).effort;
    if (typeof model !== "string" || !isPlausibleModelId(model.trim())) continue;
    out[feature] = { model: model.trim(), effort: isEffort(effort) ? effort : "" };
  }
  return out;
}

/** Features that "detailed mode" can pin to their own model (grouped for the UI). */
export const TUNABLE_FEATURES: ReadonlyArray<{
  group: "research" | "tracker";
  feature: AiFeature;
}> = [
  { group: "research", feature: "research.scout" },
  { group: "research", feature: "research.research" },
  { group: "research", feature: "research.jobfit" },
  { group: "research", feature: "research.discover" },
  { group: "research", feature: "research.writer" },
  { group: "research", feature: "research.reviewer" },
  { group: "tracker", feature: "tracker.sync.triage" },
  { group: "tracker", feature: "tracker.sync.identity" },
  { group: "tracker", feature: "tracker.sync.events" },
  { group: "tracker", feature: "tracker.signals" },
  { group: "tracker", feature: "tracker.match" },
  { group: "tracker", feature: "tracker.timeline" },
  { group: "tracker", feature: "tracker.followup" },
];
