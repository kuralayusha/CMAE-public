/**
 * Pure request guards for the public POST /api/i18n/translate endpoint
 * (validation + per-IP rate limiting). No Next/server imports so it is
 * unit-testable on its own.
 *
 * The endpoint spends the maintainer's OPENROUTER_API_KEY on the hosted
 * deployment, so it must reject junk cheaply before any LLM work happens.
 */
import { PREFERRED_LANGUAGES } from "@/lib/settings/languages";

/** Real callers send `{ "targetLanguage": "tr" }` (~30 bytes). */
export const MAX_BODY_BYTES = 1024;
/** The body is a flat object with a single expected key. */
export const MAX_BODY_KEYS = 4;
/** Max chars of the `targetLanguage` string (accepted BCP-47 tags are shorter). */
export const MAX_LANGUAGE_CHARS = 16;

/** Primary language subtags the UI offers (the supported-target allow-list). */
export const SUPPORTED_PRIMARY_LANGUAGES: ReadonlySet<string> = new Set(
  PREFERRED_LANGUAGES.map((l) => l.code.toLowerCase()),
);

/** language[-script][-region], e.g. "tr", "pt-BR", "zh-Hant", "es-419". */
const BCP47_LIKE = /^[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?$/;

export type GuardResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 413 | 429; error: string; retryAfterSec?: number };

/** Validate and normalise (lower-case) a target language code. */
export function validateTargetLanguage(raw: unknown): GuardResult<string> {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, status: 400, error: "targetLanguage is required" };
  }
  const code = raw.trim().toLowerCase();
  if (code.length > MAX_LANGUAGE_CHARS || !BCP47_LIKE.test(code)) {
    return {
      ok: false,
      status: 400,
      error: 'targetLanguage must be a BCP-47-like code such as "tr" or "pt-BR"',
    };
  }
  const primary = code.split("-")[0];
  if (!SUPPORTED_PRIMARY_LANGUAGES.has(primary)) {
    return {
      ok: false,
      status: 400,
      error: `Unsupported targetLanguage "${primary}"`,
    };
  }
  return { ok: true, value: code };
}

/**
 * Parse the raw request text: enforce size and shape limits, then validate the
 * language. Unknown extra keys are tolerated (up to MAX_BODY_KEYS) but ignored.
 */
export function parseTranslateBody(
  rawText: string,
): GuardResult<{ targetLanguage: string }> {
  if (Buffer.byteLength(rawText, "utf8") > MAX_BODY_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `Request body too large (max ${MAX_BODY_BYTES} bytes)`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, status: 400, error: "Body must be valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: "Body must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).length > MAX_BODY_KEYS) {
    return {
      ok: false,
      status: 400,
      error: `Too many keys in body (max ${MAX_BODY_KEYS})`,
    };
  }
  const lang = validateTargetLanguage(obj.targetLanguage);
  if (!lang.ok) return lang;
  return { ok: true, value: { targetLanguage: lang.value } };
}

/**
 * Read the request body as text without trusting Content-Length alone:
 * returns 413 as soon as the streamed size exceeds the limit.
 */
export async function readLimitedText(
  req: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<GuardResult<string>> {
  const tooLarge: GuardResult<string> = {
    ok: false,
    status: 413,
    error: `Request body too large (max ${maxBytes} bytes)`,
  };
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge;
  if (!req.body) return { ok: true, value: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return tooLarge;
    }
    chunks.push(value);
  }
  return { ok: true, value: Buffer.concat(chunks).toString("utf8") };
}

// ---------------------------------------------------------------------------
// Per-IP sliding-window rate limit
// ---------------------------------------------------------------------------

/**
 * In-memory sliding-window limiter.
 *
 * NOTE: state lives in this process's memory only. On serverless hosts
 * (Vercel) instances do not share memory and are recycled, so this is a
 * best-effort speed bump, not a guarantee. The real fix is an upstream limit:
 * Vercel WAF rate limiting or a shared store such as Upstash Redis.
 */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    readonly maxKeys = 10_000,
  ) {}

  check(
    key: string,
    now: number = Date.now(),
  ): { allowed: true } | { allowed: false; retryAfterSec: number } {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const retryMs = recent[0] + this.windowMs - now;
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)),
      };
    }
    recent.push(now);
    this.hits.delete(key); // re-insert so Map iteration stays in recency order
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.prune(now);
    return { allowed: true };
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [k, v] of this.hits) {
      if (!v.some((t) => t > cutoff)) this.hits.delete(k);
    }
    // Still too many distinct keys: drop the least recently used ones.
    while (this.hits.size > this.maxKeys) {
      const first = this.hits.keys().next().value;
      if (first === undefined) break;
      this.hits.delete(first);
    }
  }
}

/** Translating a whole pack is expensive: a handful of requests per IP/hour. */
export const TRANSLATE_LIMIT = 10;
export const TRANSLATE_WINDOW_MS = 60 * 60 * 1000;

/** Client IP from proxy headers (Vercel sets x-forwarded-for / x-real-ip). */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first.slice(0, 64);
  }
  return (headers.get("x-real-ip") || "unknown").trim().slice(0, 64);
}
