import { NextResponse } from "next/server";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { collectDiagnostics } from "@/lib/sync/diagnostics";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  try {
    return NextResponse.json(collectDiagnostics(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
