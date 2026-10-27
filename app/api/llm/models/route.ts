import { NextResponse } from "next/server";
import { fetchOpenRouterModels, type OpenRouterModel } from "@/lib/llm/openrouter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TTL_MS = 10 * 60_000;
let cache: { at: number; models: OpenRouterModel[] } | null = null;

/** OpenRouter's public model catalog (no key needed), cached for 10 minutes. */
export async function GET() {
  try {
    if (!cache || Date.now() - cache.at > TTL_MS) {
      cache = {
        at: Date.now(),
        models: await fetchOpenRouterModels(fetch, AbortSignal.timeout(15_000)),
      };
    }
    return NextResponse.json({ models: cache.models });
  } catch (err) {
    // Stale catalog beats an empty picker when OpenRouter is briefly down.
    if (cache) return NextResponse.json({ models: cache.models, stale: true });
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "models_unavailable", message }, { status: 502 });
  }
}
