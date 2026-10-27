import { createClient } from "npm:@supabase/supabase-js@2";

// Read-only public price table for CMAE usage cost estimates.
Deno.serve(async (req: Request) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "method" }), { status: 405 });
  }
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await sb
    .from("cmae_model_prices")
    .select("model_id, valid_from, input, cache_read, cache_write, output")
    .order("valid_from", { ascending: true });
  if (error || !data?.length) {
    return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
  }
  // Keep version label ingest-safe (no '+'); ISO offsets become 'Z' form.
  const latest = data
    .map((r) => String(r.valid_from))
    .sort()
    .pop()!
    .replace(/\+00:00$/, "Z")
    .replace(/\+/g, "p");
  const version = "remote-" + latest;
  const prices = data.map((r) => ({
    model_id: r.model_id,
    valid_from: r.valid_from,
    input: Number(r.input),
    cache_read: Number(r.cache_read),
    cache_write: Number(r.cache_write),
    output: Number(r.output),
  }));
  return new Response(JSON.stringify({ version, prices }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
});
