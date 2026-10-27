import "server-only";

import { t } from "@/lib/i18n/t";
import { providerOf } from "./catalog";
import { OpenRouterError } from "./openrouter";

/** Brand label of the model's company, or its raw slug prefix for custom models. */
function providerLabel(model: string): string {
  return providerOf(model)?.label ?? (model.split("/")[0] || model);
}

/**
 * Turn an OpenRouter failure into something a user can act on. The model is in
 * the message because the usual cause is a mismatch: the model belongs to a
 * company the user has no key for in OpenRouter (BYOK) and the account has no
 * credits to pay for it instead.
 */
export function describeOpenRouterError(err: unknown, model: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  const status = err instanceof OpenRouterError ? err.status : 0;
  const m = msg.toLowerCase();
  const vars = { model, provider: providerLabel(model) };
  if (status === 401 || m.includes("no auth") || m.includes("invalid api key")) {
    return t("llm.error.invalidKey");
  }
  if (status === 402 || m.includes("insufficient credits")) {
    return t("llm.error.noCredits", vars);
  }
  if (status === 403) return t("llm.error.forbidden", vars);
  if (status === 404 || m.includes("no endpoints") || m.includes("not a valid model")) {
    return t("llm.error.modelUnavailable", vars);
  }
  if (status === 429) return t("llm.error.rateLimit");
  if (m.includes("timeout") || m.includes("timed out")) return t("llm.error.timeout");
  return msg.slice(0, 200);
}
