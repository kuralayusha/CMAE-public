import { NextResponse } from "next/server";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { listTrackerSections } from "@/lib/tracker/list";

export const runtime = "nodejs";

export async function GET() {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  try {
    const data = listTrackerSections();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
