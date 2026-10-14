import { NextResponse } from "next/server";
import { resetAppForOnboarding } from "@/lib/onboarding/reset";
import { isOnboardingComplete, isOnboardingFlagSet } from "@/lib/onboarding/status";

export const runtime = "nodejs";

/** Full wipe: SQLite + workspace + search jobs → fresh install → onboarding. */
export async function POST() {
  try {
    resetAppForOnboarding();
    if (isOnboardingFlagSet() || isOnboardingComplete()) {
      return NextResponse.json(
        { error: "Onboarding still appears complete after reset" },
        { status: 500 },
      );
    }
    return NextResponse.json({
      ok: true,
      redirectTo: "/onboarding",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
