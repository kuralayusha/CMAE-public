/**
 * AI call labels. Every caller passes its label explicitly — nothing is
 * guessed from prompts. Pure module (no DB / server-only imports).
 */

export const AI_FEATURES = [
  "tracker.sync.triage",
  "tracker.sync.identity",
  "tracker.sync.events",
  "tracker.followup",
  "tracker.timeline",
  "tracker.match",
  "tracker.signals",
  "research.scout",
  "research.research",
  "research.reviewer",
  "research.writer",
  "research.jobfit",
  "research.discover",
  "i18n.translate",
  "onboarding.verify",
] as const;

export type AiFeature = (typeof AI_FEATURES)[number];

export type SyncMode = "incremental" | "hard";

/**
 * Response-cache policy (explicit allow-list). Deterministic, side-effect-free
 * and repeatable calls only. Creative output (research.writer, drafts) and the
 * live key check (onboarding.verify) are NEVER cached.
 */
const CACHEABLE: ReadonlySet<AiFeature> = new Set<AiFeature>([
  "tracker.sync.triage",
  "tracker.sync.events",
  "tracker.sync.identity",
  "i18n.translate",
  "research.discover",
  "research.jobfit",
]);

export function isCacheableFeature(feature: AiFeature): boolean {
  return CACHEABLE.has(feature);
}
