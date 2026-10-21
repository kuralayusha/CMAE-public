/**
 * Pure LLM transport (no DB / i18n / server-only imports) so the derive
 * stages and the eval harness share one call path.
 */

import { Agent } from "@cursor/sdk";

export const TRACKER_LLM_MODEL = "composer-2.5";
export const TRACKER_LLM_TIMEOUT_MS = 90_000;

/** prompt → raw model text. Throws on timeout / empty response. */
export type LlmFn = (prompt: string) => Promise<string>;

export class LlmTimeoutError extends Error {
  constructor(seconds: number) {
    super(`LLM timeout after ${seconds}s`);
    this.name = "LlmTimeoutError";
  }
}

export async function promptLlm(input: {
  prompt: string;
  apiKey: string;
  cwd: string;
  model?: string;
  timeoutMs?: number;
  timeoutError?: () => Error;
  emptyError?: (status: string) => Error;
}): Promise<string> {
  const timeoutMs = input.timeoutMs ?? TRACKER_LLM_TIMEOUT_MS;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Agent.prompt(input.prompt, {
        apiKey: input.apiKey,
        model: { id: input.model ?? TRACKER_LLM_MODEL },
        local: { cwd: input.cwd },
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            input.timeoutError?.() ??
              new LlmTimeoutError(Math.round(timeoutMs / 1000)),
          );
        }, timeoutMs);
      }),
    ]);
    if (result.status === "error" || !result.result) {
      const status = String(result.status ?? "unknown");
      throw input.emptyError?.(status) ?? new Error(`LLM returned no result (${status})`);
    }
    return String(result.result).trim();
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/** First JSON object / array in model text (tolerates prose and ``` fences). */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text].filter(Boolean) as string[];
  for (const src of candidates) {
    const start = src.search(/[[{]/);
    if (start < 0) continue;
    const open = src[start]!;
    const close = open === "{" ? "}" : "]";
    const end = src.lastIndexOf(close);
    if (end <= start) continue;
    try {
      return JSON.parse(src.slice(start, end + 1)) as T;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/** Run `fn` over items with at most `limit` in flight; keeps input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        out[i] = await fn(items[i]!, i);
      }
    },
  );
  await Promise.all(workers);
  return out;
}
