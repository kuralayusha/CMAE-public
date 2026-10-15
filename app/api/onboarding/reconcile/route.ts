import { NextResponse } from "next/server";
import { closeDb, getDb } from "@/lib/db/client";
import {
  isOnboardingComplete,
  isOnboardingFlagSet,
} from "@/lib/onboarding/status";
import { getAppRoot, getDataDir } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * After onboarding complete (or wipe races): force the same app-root + SQLite
 * handle the layouts use, so Tracker gate matches /api/onboarding/status.
 */
export async function POST() {
  try {
    const appRoot = getAppRoot();
    const dataDir = getDataDir();
    closeDb();
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
