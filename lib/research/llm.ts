import { promptWithUsage, type AiFeature } from "@/lib/ai-usage";
import { t } from "@/lib/i18n/t";
import { llmForFeature, resolveOpenRouterKey } from "@/lib/llm/config";
import { throwIfCanceled, whenJobAborted } from "./cancel";
import { speak } from "./speak";
import type { SpecialistId } from "./types";

export async function askLlm(
  jobId: string,
  feature: AiFeature,
  prompt: string,
  label?: string,
  agent: SpecialistId | "conductor" = "conductor",
): Promise<string> {
  throwIfCanceled(jobId);
  speak(
    jobId,
    agent,
    "think",
    label || t("terminal.detail.modelThinking"),
    t("terminal.plain.evaluating"),
  );
  const apiKey = resolveOpenRouterKey();
  throwIfCanceled(jobId);

  // promptWithUsage races the request against the job abort promise and
  // aborts the fetch, so cancel unblocks the pipeline immediately.
  const choice = llmForFeature(feature);
  const result = await promptWithUsage({
    feature,
    runId: jobId,
    prompt,
    apiKey,
    model: choice.model,
    reasoningEffort: choice.effort,
    cancelRace: whenJobAborted(jobId),
    emptyError: (status) => new Error(t("errors.llmNoResponse", { status })),
  });

  throwIfCanceled(jobId);

  const text = result.text;
  const preview = text.replace(/\s+/g, " ").slice(0, 160);
  const shortPreview = `${preview.slice(0, 90)}${preview.length > 90 ? "…" : ""}`;
  speak(
    jobId,
    agent,
    "think",
    t("terminal.detail.llmPreview", {
      preview: `${preview}${text.length > 160 ? "…" : ""}`,
    }),
    t("terminal.plain.responseReceived", { preview: shortPreview }),
  );
  return text;
}

export function extractJson<T>(text: string): T | null {
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}
