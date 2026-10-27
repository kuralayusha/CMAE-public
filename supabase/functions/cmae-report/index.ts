import { createClient } from "npm:@supabase/supabase-js@2";

// Admin-only CMAE usage report. Auth = shared secret hashed in cmae_report_auth.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
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

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

type ModelAgg = {
  model: string;
  calls: number;
  runs: Set<string>;
  features: Map<string, number>;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  saved_usd: number;
  cache_hits: number;
};

function addToModel(
  map: Map<string, ModelAgg>,
  e: Record<string, unknown>,
) {
  const model = e.model != null && String(e.model) !== "" ? String(e.model) : "unknown";
  let m = map.get(model);
  if (!m) {
    m = {
      model,
      calls: 0,
      runs: new Set(),
      features: new Map(),
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      cost_usd: 0,
      saved_usd: 0,
      cache_hits: 0,
    };
    map.set(model, m);
  }
  m.calls += 1;
  if (e.run_id != null && e.run_id !== "") m.runs.add(String(e.run_id));
  const f = String(e.feature);
  m.features.set(f, (m.features.get(f) ?? 0) + 1);
  m.input_tokens += num(e.input_tokens);
  m.output_tokens += num(e.output_tokens);
  m.cache_read_tokens += num(e.cache_read_tokens);
  m.cache_write_tokens += num(e.cache_write_tokens);
  m.reasoning_tokens += num(e.reasoning_tokens);
  m.cost_usd += num(e.cost_micro_usd) / 1_000_000;
  m.saved_usd += num(e.saved_cost_micro_usd) / 1_000_000;
  if (e.cache_hit) m.cache_hits += 1;
}

function modelRows(map: Map<string, ModelAgg>) {
  return [...map.values()]
    .map((m) => ({
      model: m.model,
      calls: m.calls,
      runs: m.runs.size,
      input_tokens: m.input_tokens,
      output_tokens: m.output_tokens,
      cache_read_tokens: m.cache_read_tokens,
      cache_write_tokens: m.cache_write_tokens,
      reasoning_tokens: m.reasoning_tokens,
      cost_usd: m.cost_usd,
      saved_usd: m.saved_usd,
      cache_hits: m.cache_hits,
      // most-called first
      features: [...m.features.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f),
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd);
}

type Sb = ReturnType<typeof createClient>;

// PostgREST caps a response at ~1000 rows, so read big views page by page.
async function selectAll(sb: Sb, view: string, cols: string, order: string) {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from(view)
      .select(cols)
      .order(order, { ascending: true })
      .range(from, from + 999);
    if (error) return null;
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) return rows;
  }
}

// Overview-level model breakdown. Primary path: the GROUP BY views
// (cmae_v_model_totals / _model_features / _user_models) — exact at any size.
async function overviewModels(sb: Sb) {
  const [totals, feats, userModels] = await Promise.all([
    selectAll(sb, "cmae_v_model_totals", "*", "model"),
    selectAll(sb, "cmae_v_model_features", "model, feature, calls", "model"),
    selectAll(sb, "cmae_v_user_models", "user_id, model", "user_id"),
  ]);
  if (!totals || !feats || !userModels) return scanOverviewModels(sb);

  const featuresByModel = new Map<string, { feature: string; calls: number }[]>();
  for (const f of feats) {
    const list = featuresByModel.get(String(f.model)) ?? [];
    list.push({ feature: String(f.feature), calls: num(f.calls) });
    featuresByModel.set(String(f.model), list);
  }
  const by_model = totals
    .map((m) => ({
      model: String(m.model),
      calls: num(m.calls),
      runs: num(m.runs),
      input_tokens: num(m.input_tokens),
      output_tokens: num(m.output_tokens),
      cache_read_tokens: num(m.cache_read_tokens),
      cache_write_tokens: num(m.cache_write_tokens),
      reasoning_tokens: num(m.reasoning_tokens),
      cost_usd: num(m.cost_usd),
      saved_usd: num(m.saved_usd),
      cache_hits: num(m.cache_hits),
      features: (featuresByModel.get(String(m.model)) ?? [])
        .sort((a, b) => b.calls - a.calls)
        .map((f) => f.feature),
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd);
  const perUser = new Map<string, Set<string>>();
  for (const r of userModels) {
    const uid = String(r.user_id);
    let set = perUser.get(uid);
    if (!set) perUser.set(uid, (set = new Set()));
    set.add(String(r.model));
  }
  return { by_model, perUser, truncated: false, source: "view" as const };
}

// Fallback when the views are missing: page through the raw events once
// (counters only, no text). Capped so a huge table can never blow the
// function's time budget; `truncated` tells the UI the cap was hit.
const OVERVIEW_PAGE = 1000;
const OVERVIEW_MAX_ROWS = 50_000;

async function scanOverviewModels(sb: Sb) {
  const grand = new Map<string, ModelAgg>();
  const perUser = new Map<string, Set<string>>();
  let scanned = 0;
  let truncated = false;
  for (let from = 0; ; from += OVERVIEW_PAGE) {
    const { data, error } = await sb
      .from("cmae_token_events")
      .select("user_id, model, feature, run_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_micro_usd, saved_cost_micro_usd, cache_hit")
      .order("event_id", { ascending: true })
      .range(from, from + OVERVIEW_PAGE - 1);
    if (error) return null;
    for (const e of data ?? []) {
      addToModel(grand, e);
      const uid = String(e.user_id);
      const model = e.model != null && String(e.model) !== "" ? String(e.model) : "unknown";
      let set = perUser.get(uid);
      if (!set) perUser.set(uid, (set = new Set()));
      set.add(model);
    }
    scanned += data?.length ?? 0;
    if ((data?.length ?? 0) < OVERVIEW_PAGE) break;
    if (scanned >= OVERVIEW_MAX_ROWS) {
      truncated = true;
      break;
    }
  }
  return { by_model: modelRows(grand), perUser, truncated, source: "scan" as const };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "method" }, 405);
  }

  const url = new URL(req.url);
  let secret =
    req.headers.get("x-cmae-report-secret") ||
    url.searchParams.get("secret") ||
    "";
  let userId = url.searchParams.get("user_id") || "";

  if (req.method === "POST") {
    try {
      const body = await req.json();
      if (typeof body?.secret === "string") secret = body.secret;
      if (typeof body?.user_id === "string") userId = body.user_id;
    } catch {
      return json({ error: "bad_json" }, 400);
    }
  }

  if (!secret || secret.length < 32 || secret.length > 128) {
    return json({ error: "secret" }, 401);
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const auth = await sb.from("cmae_report_auth").select("secret_hash").eq("id", 1).maybeSingle();
  if (auth.error || !auth.data?.secret_hash) return json({ error: "unconfigured" }, 503);
  const hash = await sha256Hex(secret);
  if (!safeEqual(auth.data.secret_hash, hash)) return json({ error: "unauthorized" }, 401);

  if (userId) {
    if (!UUID_RE.test(userId)) return json({ error: "user_id" }, 400);

    const [userRow, totals, withTs] = await Promise.all([
      sb.from("cmae_users").select("user_id, first_seen, last_seen, app_version, platform").eq("user_id", userId).maybeSingle(),
      sb.from("cmae_v_user_totals").select("*").eq("user_id", userId).maybeSingle(),
      sb
        .from("cmae_token_events")
        .select("feature, model, sync_mode, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_micro_usd, saved_cost_micro_usd, cache_hit, run_id, status, ts")
        .eq("user_id", userId)
        .order("ts", { ascending: false })
        .limit(5000),
    ]);

    if (!totals.data && !userRow.data) return json({ error: "not_found" }, 404);

    const featureMap = new Map<string, {
      feature: string;
      calls: number;
      runs: Set<string>;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      reasoning_tokens: number;
      cost_usd: number;
      saved_usd: number;
      cache_hits: number;
    }>();

    const modelMap = new Map<string, ModelAgg>();

    const runMap = new Map<string, {
      run_id: string;
      calls: number;
      features: Set<string>;
      models: Set<string>;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      reasoning_tokens: number;
      cost_usd: number;
      first_ts?: string;
      last_ts?: string;
    }>();

    for (const e of withTs.data ?? []) {
      addToModel(modelMap, e);
      const f = String(e.feature);
      let fm = featureMap.get(f);
      if (!fm) {
        fm = {
          feature: f,
          calls: 0,
          runs: new Set(),
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          cost_usd: 0,
          saved_usd: 0,
          cache_hits: 0,
        };
        featureMap.set(f, fm);
      }
      fm.calls += 1;
      fm.input_tokens += num(e.input_tokens);
      fm.output_tokens += num(e.output_tokens);
      fm.cache_read_tokens += num(e.cache_read_tokens);
      fm.cache_write_tokens += num(e.cache_write_tokens);
      fm.reasoning_tokens += num(e.reasoning_tokens);
      fm.cost_usd += num(e.cost_micro_usd) / 1_000_000;
      fm.saved_usd += num(e.saved_cost_micro_usd) / 1_000_000;
      if (e.cache_hit) fm.cache_hits += 1;

      const rid = e.run_id != null && e.run_id !== "" ? String(e.run_id) : null;
      if (rid) {
        fm.runs.add(rid);
        let rm = runMap.get(rid);
        if (!rm) {
          rm = {
            run_id: rid,
            calls: 0,
            features: new Set(),
            models: new Set(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
            cost_usd: 0,
          };
          runMap.set(rid, rm);
        }
        rm.calls += 1;
        rm.features.add(f);
        rm.models.add(e.model != null && String(e.model) !== "" ? String(e.model) : "unknown");
        rm.input_tokens += num(e.input_tokens);
        rm.output_tokens += num(e.output_tokens);
        rm.cache_read_tokens += num(e.cache_read_tokens);
        rm.cache_write_tokens += num(e.cache_write_tokens);
        rm.reasoning_tokens += num(e.reasoning_tokens);
        rm.cost_usd += num(e.cost_micro_usd) / 1_000_000;
        const ts = String(e.ts);
        if (!rm.first_ts || ts < rm.first_ts) rm.first_ts = ts;
        if (!rm.last_ts || ts > rm.last_ts) rm.last_ts = ts;
      }
    }

    const t = totals.data;
    return json({
      user: {
        user_id: userId,
        first_seen: userRow.data?.first_seen ?? null,
        last_seen: userRow.data?.last_seen ?? null,
        app_version: userRow.data?.app_version ?? null,
        platform: userRow.data?.platform ?? null,
      },
      totals: {
        runs: num(t?.runs),
        calls: num(t?.calls),
        input_tokens: num(t?.input_tokens),
        output_tokens: num(t?.output_tokens),
        cache_read_tokens: num(t?.cache_read_tokens),
        cache_write_tokens: num(t?.cache_write_tokens),
        reasoning_tokens: num(t?.reasoning_tokens),
        cost_usd: num(t?.cost_usd),
        saved_usd: num(t?.saved_usd),
        first_event_at: t?.first_event_at ?? null,
        last_event_at: t?.last_event_at ?? null,
      },
      by_model: modelRows(modelMap),
      by_feature: [...featureMap.values()]
        .map((f) => ({
          feature: f.feature,
          calls: f.calls,
          runs: f.runs.size,
          input_tokens: f.input_tokens,
          output_tokens: f.output_tokens,
          cache_read_tokens: f.cache_read_tokens,
          cache_write_tokens: f.cache_write_tokens,
          reasoning_tokens: f.reasoning_tokens,
          cost_usd: f.cost_usd,
          saved_usd: f.saved_usd,
          cache_hits: f.cache_hits,
        }))
        .sort((a, b) => b.cost_usd - a.cost_usd),
      runs: [...runMap.values()]
        .map((r) => ({
          run_id: r.run_id,
          calls: r.calls,
          features: [...r.features].sort(),
          models: [...r.models].sort(),
          input_tokens: r.input_tokens,
          output_tokens: r.output_tokens,
          cache_read_tokens: r.cache_read_tokens,
          cache_write_tokens: r.cache_write_tokens,
          reasoning_tokens: r.reasoning_tokens,
          cost_usd: r.cost_usd,
          first_ts: r.first_ts ?? null,
          last_ts: r.last_ts ?? null,
        }))
        .sort((a, b) => String(b.last_ts).localeCompare(String(a.last_ts)))
        .slice(0, 200),
    });
  }

  const { data: totals, error } = await sb
    .from("cmae_v_user_totals")
    .select("*")
    .order("cost_usd", { ascending: false });
  if (error) return json({ error: "db" }, 500);

  const ids = (totals ?? []).map((r) => r.user_id);
  const { data: users } = ids.length
    ? await sb.from("cmae_users").select("user_id, first_seen, last_seen, app_version, platform").in("user_id", ids)
    : { data: [] as { user_id: string }[] };
  const uMap = new Map((users ?? []).map((u) => [u.user_id, u]));

  const ov = await overviewModels(sb);

  const cards = (totals ?? []).map((t) => {
    const u = uMap.get(t.user_id) as {
      first_seen?: string;
      last_seen?: string;
      app_version?: string;
      platform?: string;
    } | undefined;
    return {
      user_id: t.user_id,
      runs: num(t.runs),
      calls: num(t.calls),
      input_tokens: num(t.input_tokens),
      output_tokens: num(t.output_tokens),
      cache_read_tokens: num(t.cache_read_tokens),
      cache_write_tokens: num(t.cache_write_tokens),
      reasoning_tokens: num(t.reasoning_tokens),
      cost_usd: num(t.cost_usd),
      saved_usd: num(t.saved_usd),
      first_event_at: t.first_event_at ?? null,
      last_event_at: t.last_event_at ?? null,
      first_seen: u?.first_seen ?? null,
      last_seen: u?.last_seen ?? null,
      app_version: u?.app_version ?? null,
      platform: u?.platform ?? null,
      models: [...(ov?.perUser.get(t.user_id) ?? [])].sort(),
    };
  });

  const grand = cards.reduce(
    (a, c) => ({
      users: a.users + 1,
      runs: a.runs + c.runs,
      calls: a.calls + c.calls,
      cost_usd: a.cost_usd + c.cost_usd,
      input_tokens: a.input_tokens + c.input_tokens,
      output_tokens: a.output_tokens + c.output_tokens,
      cache_read_tokens: a.cache_read_tokens + c.cache_read_tokens,
      reasoning_tokens: a.reasoning_tokens + c.reasoning_tokens,
    }),
    { users: 0, runs: 0, calls: 0, cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0 },
  );

  return json({
    grand: {
      ...grand,
      by_model: ov?.by_model ?? [],
      by_model_truncated: ov?.truncated ?? false,
      by_model_source: ov?.source ?? null,
    },
    users: cards,
  });
});
