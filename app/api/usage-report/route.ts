import { usageConfig } from "@/lib/ai-usage/config";
import { buildLocalUsageReport } from "@/lib/ai-usage/local-report";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function fetchAdminReport(userId?: string | null) {
  const cfg = usageConfig();
  if (!cfg.reportUrl || !cfg.reportSecret) {
    return NextResponse.json(
      { error: "admin_unavailable", adminAvailable: false },
      { status: 404 },
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

  if (body && typeof body === "object" && !Array.isArray(body)) {
    return NextResponse.json(
      { ...(body as Record<string, unknown>), adminAvailable: true, scope: "admin" },
      { status: res.status },
    );
  }
  return NextResponse.json(body, { status: res.status });
}

/**
 * Default: this machine's local AI usage (always works).
 * `?admin=1`: full Supabase user list — only when CMAE_USAGE_REPORT_SECRET is set.
 * Never surfaces secret-configuration warnings to the UI.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const wantAdmin = url.searchParams.get("admin") === "1";
    const cfg = usageConfig();
    const adminAvailable = Boolean(cfg.reportUrl && cfg.reportSecret);

    if (wantAdmin) {
      const userId = url.searchParams.get("user_id");
      return await fetchAdminReport(userId);
    }

    return NextResponse.json(
      buildLocalUsageReport(undefined, { adminAvailable }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "report_failed", message: msg }, { status: 502 });
  }
}
