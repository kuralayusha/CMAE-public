import { NextResponse } from "next/server";
import { getOperationsStatus } from "@/lib/operations/status";
import { requireOnboardedResponse } from "@/lib/onboarding/http";

export const runtime = "nodejs";

/** Snapshot of long-running ops that should lock Settings. */
export async function GET() {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  return NextResponse.json(getOperationsStatus());
}
