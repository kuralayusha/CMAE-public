import { NextResponse } from "next/server";
import { setSyncUiVisible } from "@/lib/sync/freshness";
import { wakeScheduler, rescheduleAfterVisibilityChange } from "@/lib/sync/scheduler";

export const runtime = "nodejs";

function tokenOk(request: Request): boolean {
  const expected = process.env.CMAE_INTERNAL_TOKEN?.trim();
  if (!expected) return false;
  const header =
    request.headers.get("x-cmae-internal-token")?.trim() ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return Boolean(header && header === expected);
}

/**
 * Electron powerMonitor / network wake bridge.
 * Requires CMAE_INTERNAL_TOKEN (injected by desktop main).
 */
export async function POST(request: Request) {
  if (!tokenOk(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    reason?: string;
    visibility?: "visible" | "hidden";
  };

  if (body.visibility === "visible" || body.visibility === "hidden") {
    setSyncUiVisible(body.visibility === "visible");
    rescheduleAfterVisibilityChange();
  }

  const reason = body.reason;
  if (
    reason === "resume" ||
    reason === "unlock" ||
    reason === "online" ||
    reason === "focus" ||
    reason === "wake"
  ) {
    wakeScheduler({ reason });
  } else if (!body.visibility) {
    wakeScheduler({ reason: "wake" });
  }

  return NextResponse.json({ ok: true });
}
