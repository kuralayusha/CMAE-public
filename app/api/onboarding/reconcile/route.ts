import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import {
  isOnboardingComplete,
  isOnboardingFlagSet,
} from "@/lib/onboarding/status";
import { getAppRoot, getDataDir } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * After onboarding complete (or wipe races): ensure SQLite is open on the
 * sticky app-root so Tracker gate matches /api/onboarding/status.
 *
 * Do NOT unconditionally closeDb() here — a long-running mail sync may hold
 * work across awaits; forcing close races it into "database connection is
 * not open". getDb() already reopens when the path flipped or the handle died.
 */
export async function POST() {
  try {
    const appRoot = getAppRoot();
    const dataDir = getDataDir();
    getDb();
    return NextResponse.json({
      ok: true,
      complete: isOnboardingComplete(),
      flagSet: isOnboardingFlagSet(),
      appRoot,
      dataDir,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
