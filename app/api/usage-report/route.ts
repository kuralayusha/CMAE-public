import { usageConfig } from "@/lib/ai-usage/config";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function fetchReport(userId?: string | null) {
  const cfg = usageConfig();
  if (!cfg.reportUrl) {
    return NextResponse.json({ error: "unconfigured_url" }, { status: 503 });
  }
  if (!cfg.reportSecret) {
    return NextResponse.json(
      {
        error: "unconfigured_secret",
        hint: "Set CMAE_USAGE_REPORT_SECRET in .env.local",
      },
      { status: 503 },
    );
  }

  const url = new URL(cfg.reportUrl);
  if (userId) url.searchParams.set("user_id", userId);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-cmae-report-secret": cfg.reportSecret,
      ...(cfg.anonKey
        ? { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}` }
        : {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: "bad_upstream", raw: text.slice(0, 200) };
  }
  return NextResponse.json(body, { status: res.status });
}

export async function GET(req: Request) {
  try {
    const userId = new URL(req.url).searchParams.get("user_id");
    return await fetchReport(userId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "proxy_failed", message: msg }, { status: 502 });
  }
}
