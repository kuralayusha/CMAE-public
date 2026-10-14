import { NextResponse } from "next/server";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import {
  getActiveSyncSession,
  getSyncSession,
  startTrackerSyncSession,
} from "@/lib/tracker/session";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Current / active sync session (for refresh reconnect). */
export async function GET() {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  const active = getActiveSyncSession();
  if (active) {
    return NextResponse.json({
      active: {
        id: active.id,
        status: active.status,
        createdAt: active.createdAt,
        error: active.error,
      },
    });
  }
  const last = getSyncSession();
  return NextResponse.json({
    active: null,
    last: last
      ? {
          id: last.id,
          status: last.status,
          createdAt: last.createdAt,
          error: last.error,
        }
      : null,
  });
}

/** Start sync (or join already-running). Work survives page refresh. */
export async function POST(req: Request) {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      skipImap?: boolean;
      /** incremental (default) | hard — hard = full window re-fetch, no DB wipe */
      mode?: "incremental" | "hard";
    };
    const mode =
      body.mode === "hard" ? "hard" : ("incremental" as const);
    const session = startTrackerSyncSession({
      skipImap: body.skipImap,
      mode,
    });
    return NextResponse.json({
      id: session.id,
      status: session.status,
      createdAt: session.createdAt,
      mode,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
