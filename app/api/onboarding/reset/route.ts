import { NextResponse } from "next/server";
import { t } from "@/lib/i18n/t";
import { resetAppForOnboarding } from "@/lib/onboarding/reset";
import { isOnboardingComplete, isOnboardingFlagSet } from "@/lib/onboarding/status";

export const runtime = "nodejs";

/** Full wipe: SQLite + workspace + search jobs → fresh install → onboarding. */
export async function POST() {
  try {
    await resetAppForOnboarding();
    if (isOnboardingFlagSet() || isOnboardingComplete()) {
      return NextResponse.json(
        { error: t("onboarding.error.resetIncomplete") },
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
