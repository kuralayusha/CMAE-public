import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db/client";
import { isTelemetryEnabled, setTelemetryEnabled } from "@/lib/ai-usage/store";

export const runtime = "nodejs";

/**
 * Anonymous AI-usage upload consent. Separate from PUT /api/settings so the
 * toggle works while a sync/research job holds the settings busy-lock.
 */
export async function GET() {
  return NextResponse.json({ enabled: isTelemetryEnabled(getSqlite()) });
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => null)) as { enabled?: unknown } | null;
  if (!body || typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "enabled must be a boolean" },
      { status: 400 },
    );
  }
  setTelemetryEnabled(body.enabled, getSqlite());
  return NextResponse.json({ enabled: body.enabled });
}
