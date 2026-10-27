import { createClient } from "npm:@supabase/supabase-js@2";

// Public telemetry ingest for CMAE token usage. No JWT: protection is the
// per-user secret (hash stored), strict validation, size and rate limits.
// Only counters and labels are accepted; no text content fields exist.

const MAX_BODY_BYTES = 512 * 1024;
const MAX_EVENTS = 500;
const MAX_EVENTS_PER_HOUR = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Labels may include ISO-ish price versions (…T00:00:00+00:00).
const LABEL_RE = /^[a-zA-Z0-9._:+-]{1,96}$/;
// Model ids are OpenRouter slugs (`vendor/model[:variant]`), so "/" is allowed here only.
const MODEL_RE = /^[a-zA-Z0-9._:+\/-]{1,96}$/;
const MAX_COUNT = 1e12;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT ? v : null;

function parseEvent(e: any, userId: string) {
  if (!e || typeof e !== "object") return null;
  if (typeof e.event_id !== "string" || !UUID_RE.test(e.event_id)) return null;
  const ts = typeof e.ts === "string" ? Date.parse(e.ts) : NaN;
  if (!Number.isFinite(ts) || ts > Date.now() + 24 * 3600_000) return null;
  for (const k of ["feature", "model", "price_version", "status"]) {
    const re = k === "model" ? MODEL_RE : LABEL_RE;
    if (typeof e[k] !== "string" || !re.test(e[k])) return null;
  }
  if (e.sync_mode != null && (typeof e.sync_mode !== "string" || !LABEL_RE.test(e.sync_mode))) return null;
  // run_id only when the client sends a real UI run (sync/research/…). Never invent.
  let runId: string | null = null;
  if (e.run_id != null && e.run_id !== "") {
    if (typeof e.run_id !== "string" || e.run_id.length > 96) return null;
    if (!LABEL_RE.test(e.run_id) && !UUID_RE.test(e.run_id)) return null;
    runId = e.run_id;
  }
  const nums: Record<string, number> = {};
  for (const k of [
    "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
    "reasoning_tokens", "cost_micro_usd", "duration_ms", "saved_input_tokens",
    "saved_cost_micro_usd",
  ]) {
    const n = count(e[k] ?? 0);
    if (n == null) return null;
    nums[k] = n;
  }
  return {
    event_id: e.event_id,
    user_id: userId,
    ts: new Date(ts).toISOString(),
    feature: e.feature,
    sync_mode: e.sync_mode ?? null,
    run_id: runId,
    model: e.model,
    price_version: e.price_version,
    status: e.status,
    usage_missing: e.usage_missing === true,
    cache_hit: e.cache_hit === true,
    ...nums,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);

  let body: any;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  const userId = body?.user_id;
  const secret = body?.secret;
  if (typeof userId !== "string" || !UUID_RE.test(userId)) return json({ error: "user_id" }, 400);
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 128) {
    return json({ error: "secret" }, 400);
  }
  if (!Array.isArray(body.events) || body.events.length > MAX_EVENTS) {
    return json({ error: "events" }, 400);
  }
  const appVersion = typeof body.app_version === "string" ? body.app_version.slice(0, 32) : null;
  const platform = typeof body.platform === "string" ? body.platform.slice(0, 32) : null;

  const rows = [];
  for (const e of body.events) {
    const row = parseEvent(e, userId);
    if (!row) return json({ error: "event_invalid" }, 400);
    rows.push(row);
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  const hash = await sha256Hex(secret);

  const ins = await sb.from("cmae_users").upsert(
    { user_id: userId, secret_hash: hash, app_version: appVersion, platform },
    { onConflict: "user_id", ignoreDuplicates: true },
  );
  if (ins.error) return json({ error: "db" }, 500);
  const cur = await sb.from("cmae_users").select("secret_hash").eq("user_id", userId).single();
  if (cur.error || !cur.data) return json({ error: "db" }, 500);
  if (!safeEqual(cur.data.secret_hash, hash)) return json({ error: "id_collision" }, 409);

  const since = new Date(Date.now() - 3600_000).toISOString();
  const recent = await sb
    .from("cmae_token_events")
    .select("event_id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("received_at", since);
  if ((recent.count ?? 0) + rows.length > MAX_EVENTS_PER_HOUR) {
    return json({ error: "rate_limited" }, 429);
  }

  if (rows.length) {
    const up = await sb
      .from("cmae_token_events")
      .upsert(rows, { onConflict: "event_id", ignoreDuplicates: true });
    if (up.error) return json({ error: "db" }, 500);
  }
  await sb
    .from("cmae_users")
    .update({ last_seen: new Date().toISOString(), app_version: appVersion, platform })
    .eq("user_id", userId);

  return json({ ok: true, accepted: rows.length });
});
