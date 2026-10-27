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

import type { AiFeature } from "@/lib/ai-usage/features";

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
