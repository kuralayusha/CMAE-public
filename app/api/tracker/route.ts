import { NextResponse } from "next/server";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { listTrackerSections } from "@/lib/tracker/list";
import { reconcilePendingAgainstLiveDrafts } from "@/lib/tracker/pending-draft";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  try {
    // Banner/clock pending is DB cache — verify against live Gmail Drafts
    await reconcilePendingAgainstLiveDrafts();
    const data = listTrackerSections();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
