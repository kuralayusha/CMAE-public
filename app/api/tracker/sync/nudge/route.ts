import { NextResponse } from "next/server";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { setSyncUiVisible } from "@/lib/sync/freshness";
import {
  rescheduleAfterVisibilityChange,
  wakeScheduler,
} from "@/lib/sync/scheduler";

export const runtime = "nodejs";

/**
 * Renderer-facing wake / visibility signal (session cookie / same-origin).
 * Does not require CMAE_INTERNAL_TOKEN.
 */
export async function POST(request: Request) {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;

  const body = (await request.json().catch(() => ({}))) as {
    reason?: string;
    visibility?: "visible" | "hidden";
  };

  if (body.visibility === "visible" || body.visibility === "hidden") {
    setSyncUiVisible(body.visibility === "visible");
    rescheduleAfterVisibilityChange();
  }

  if (
    body.reason === "focus" ||
    body.reason === "online" ||
    body.reason === "resume" ||
    body.reason === "wake"
  ) {
    wakeScheduler({
      reason: body.reason === "resume" ? "resume" : body.reason,
    });
  }

  return NextResponse.json({ ok: true });
}
