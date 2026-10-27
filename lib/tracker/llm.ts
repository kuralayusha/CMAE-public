import { t } from "@/lib/i18n/t";
import { modelForFeature, resolveOpenRouterKey } from "@/lib/llm/config";
import "@/lib/ai-usage"; // registers the usage/cache backend
import type { AiFeature, SyncMode } from "@/lib/ai-usage/features";
import { promptLlm, TRACKER_LLM_TIMEOUT_MS } from "./llm-core";

export { extractJson } from "./llm-core";

/** Model that will serve `feature` (provenance label stored next to results). */
export function trackerModel(feature: AiFeature): string {
  return modelForFeature(feature);
}

export type TrackerLlmOpts = {
  feature: AiFeature;
  syncMode?: SyncMode;
  bypassCache?: boolean;
  promptVersion?: string | number;
};

export async function askTrackerLlm(
  prompt: string,
  opts: TrackerLlmOpts,
): Promise<string> {
  const apiKey = resolveOpenRouterKey();
  return promptLlm({
    ...opts,
    prompt,
    apiKey,
    model: modelForFeature(opts.feature),
    timeoutMs: TRACKER_LLM_TIMEOUT_MS,
    timeoutError: () =>
      new Error(
        t("errors.llmTimeout", { seconds: TRACKER_LLM_TIMEOUT_MS / 1000 }),
      ),
    emptyError: (status) => new Error(t("errors.llmNoResponse", { status })),
  });
}
