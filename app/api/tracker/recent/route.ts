import { NextResponse } from "next/server";
import { bumpRevision } from "@/lib/db/revision";
import { getSqlite } from "@/lib/db/client";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { clearRecentItems } from "@/lib/tracker/recent";

export const runtime = "nodejs";

/** Clear the Recent highlight strip (items stay in their status sections). */
export async function DELETE() {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  try {
    const db = getSqlite();
    const cleared = clearRecentItems(db);
    const rev = bumpRevision(db, "mutation", "global", "all");
    return NextResponse.json({
      ok: true,
      cleared,
      recent: [],
      rev,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
