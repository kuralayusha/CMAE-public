import { NextResponse } from "next/server";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { listTrackerSections } from "@/lib/tracker/list";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  try {
    // Pure read — Gmail Drafts reconcile runs at sync end / after draft create.
    const data = listTrackerSections();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
