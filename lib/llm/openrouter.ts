/**
 * OpenRouter transport — plain `fetch`, no SDK, no DB / server-only imports
 * (the eval harness uses it through lib/ai-usage/call.ts).
 *
 * Usage object (verified against openrouter.ai/docs/guides/administration/
 * usage-accounting; always returned, no opt-in):
 *   prompt_tokens            includes cached tokens
 *   completion_tokens        includes reasoning tokens
 *   cost                     credits charged to the OpenRouter account (USD);
 *                            this is what the OpenRouter dashboard sums. For
 *                            BYOK requests it is only OpenRouter's fee
 *   cost_details.upstream_inference_cost
 *                            what the upstream provider charged. Present on
 *                            normal requests too (≈ cost) — do not add it to
 *                            cost; see openRouterCostUsd in ai-usage/call.ts
 *   prompt_tokens_details.cached_tokens / cache_write_tokens
 *   completion_tokens_details.reasoning_tokens
 */

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const APP_REFERER = "https://cmae.vercel.app";
const APP_TITLE = "CMAE";

export type OpenRouterUsage = {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** USD charged to the OpenRouter account; null when not reported. */
  costUsd: number | null;
  /** USD charged by the upstream provider (BYOK); 0 otherwise. */
  upstreamCostUsd: number;
};

export type OpenRouterChatResult = {
  text: string;
  usage: OpenRouterUsage | null;
  finishReason: string | null;
};

export class OpenRouterError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.code = code;
  }
}

export type OpenRouterChatInput = {
  apiKey: string;
  model: string;
  prompt: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** `reasoning.effort`; omitted = the model's own default. */
  reasoningEffort?: string | null;
  /** Retries for 429 / 5xx / network errors (not for 4xx). Default 2. */
  retries?: number;
};

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;

function parseUsage(raw: unknown): OpenRouterUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const pd = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cd = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  const cost = (u.cost_details ?? {}) as Record<string, unknown>;
  const hasTokens =
    typeof u.prompt_tokens === "number" || typeof u.completion_tokens === "number";
  if (!hasTokens && typeof u.cost !== "number") return null;
  return {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    cachedTokens: num(pd.cached_tokens),
    cacheWriteTokens: num(pd.cache_write_tokens),
    reasoningTokens: num(cd.reasoning_tokens),
    costUsd:
      typeof u.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0
        ? u.cost
        : null,
    upstreamCostUsd: num(cost.upstream_inference_cost),
  };
}

function errorFrom(status: number, body: unknown): OpenRouterError {
  const e =
    body && typeof body === "object"
      ? ((body as Record<string, unknown>).error as Record<string, unknown> | undefined)
      : undefined;
  const message =
    (typeof e?.message === "string" && e.message) || `OpenRouter HTTP ${status}`;
  const code =
    typeof e?.code === "string" || typeof e?.code === "number"
      ? String(e.code)
      : null;
  return new OpenRouterError(message, status, code);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export async function openRouterChat(
  input: OpenRouterChatInput,
): Promise<OpenRouterChatResult> {
  const f = input.fetchImpl ?? fetch;
  const maxRetries = input.retries ?? 2;
  let attempt = 0;
  for (;;) {
    try {
      const res = await f(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": APP_REFERER,
          "X-Title": APP_TITLE,
        },
        body: JSON.stringify({
          model: input.model,
          messages: [{ role: "user", content: input.prompt }],
          stream: false,
          ...(input.reasoningEffort
            ? { reasoning: { effort: input.reasoningEffort } }
            : {}),
        }),
        signal: input.signal,
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON error page */
      }
      if (!res.ok) throw errorFrom(res.status, body);
      const o = (body ?? {}) as Record<string, unknown>;
      // OpenRouter can answer 200 with an `error` object (upstream failure).
      if (o.error) throw errorFrom(502, body);
      const choice = (o.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const message = choice?.message as Record<string, unknown> | undefined;
      const content = message?.content;
      return {
        text: typeof content === "string" ? content.trim() : "",
        usage: parseUsage(o.usage),
        finishReason:
          typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
      };
    } catch (err) {
      if (input.signal?.aborted) throw err;
      const status = err instanceof OpenRouterError ? err.status : 0;
      const retryable = status === 0 || status === 429 || status >= 500;
      if (!retryable || attempt >= maxRetries) throw err;
      attempt += 1;
      await sleep(1000 * 3 ** (attempt - 1), input.signal);
    }
  }
}

export type OpenRouterModel = {
  id: string;
  name: string;
  contextLength: number | null;
  /** USD per 1M tokens */
  promptPerM: number | null;
  completionPerM: number | null;
  free: boolean;
  /** Unix seconds; newest-first ordering inside a model family. */
  created: number | null;
  /** `reasoning.effort` values the model accepts; null = no effort control. */
  efforts: string[] | null;
  /** True when the model always reasons (effort "none" is not offered). */
  reasoningMandatory: boolean;
};

const perM = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e4) / 1e4 : null;
};

/** Names that are text-out on paper but are not chat models for this app. */
const NOT_CHAT = /(guard|embed|moderat|whisper|voxtral|tts\b|transcri|safeguard|rerank|speech|audio|image|vision|omni|-vl\b)/i;

/**
 * Text → text chat models only. Output must be exactly text (no image/audio
 * output), input must accept text, and aliases/routers, batch/free/variant
 * suffixes (`:batch`, `:free`, …), expired and non-chat models are dropped.
 */
export function isTextChatModel(m: Record<string, unknown>): boolean {
  const id = typeof m.id === "string" ? m.id : "";
  if (!id || id.startsWith("~") || id.startsWith("openrouter/") || id.includes(":")) {
    return false;
  }
  const arch = (m.architecture ?? {}) as {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  const out = arch.output_modalities;
  if (!Array.isArray(out) || out.length !== 1 || out[0] !== "text") return false;
  if (Array.isArray(arch.input_modalities) && !arch.input_modalities.includes("text")) {
    return false;
  }
  if (NOT_CHAT.test(id) || NOT_CHAT.test(typeof m.name === "string" ? m.name : "")) {
    return false;
  }
  const exp = typeof m.expiration_date === "string" ? Date.parse(m.expiration_date) : NaN;
  if (Number.isFinite(exp) && exp < Date.now()) return false;
  return true;
}

/** Public catalog (no key needed), filtered by {@link isTextChatModel}. */
export async function fetchOpenRouterModels(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<OpenRouterModel[]> {
  const res = await fetchImpl(`${OPENROUTER_BASE_URL}/models`, {
    headers: { "HTTP-Referer": APP_REFERER, "X-Title": APP_TITLE },
    signal,
  });
  if (!res.ok) throw new OpenRouterError(`OpenRouter HTTP ${res.status}`, res.status);
  const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
  const out: OpenRouterModel[] = [];
  for (const m of body.data ?? []) {
    if (!isTextChatModel(m)) continue;
    const id = m.id as string;
    const pricing = (m.pricing ?? {}) as Record<string, unknown>;
    const promptPerM = perM(pricing.prompt);
    const completionPerM = perM(pricing.completion);
    const rsn = (m.reasoning ?? null) as {
      mandatory?: boolean;
      supported_efforts?: unknown;
    } | null;
    const efforts = Array.isArray(rsn?.supported_efforts)
      ? (rsn!.supported_efforts as unknown[]).filter(
          (e): e is string => typeof e === "string",
        )
      : [];
    out.push({
      id,
      name: typeof m.name === "string" && m.name ? m.name : id,
      contextLength: typeof m.context_length === "number" ? m.context_length : null,
      promptPerM,
      completionPerM,
      free: promptPerM === 0 && completionPerM === 0,
      created: typeof m.created === "number" ? m.created : null,
      efforts: efforts.length ? efforts : null,
      reasoningMandatory: Boolean(rsn?.mandatory),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
