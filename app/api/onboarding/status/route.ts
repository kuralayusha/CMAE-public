import { NextResponse } from "next/server";
import {
  getOnboardingGaps,
  isOnboardingComplete,
  isOnboardingFlagSet,
} from "@/lib/onboarding/status";
import { getDataDir } from "@/lib/paths";
import { getPublicSettings } from "@/lib/settings/service";
import { listCvs } from "@/lib/cv/library";

export const runtime = "nodejs";

export async function GET() {
  // Touch DB so schema exists on first launch
  const settings = getPublicSettings();
  let cvs: ReturnType<typeof listCvs> = [];
  try {
    cvs = listCvs();
  } catch {
    cvs = [];
  }
  return NextResponse.json({
    complete: isOnboardingComplete(),
    flagSet: isOnboardingFlagSet(),
    gaps: getOnboardingGaps(),
    settings,
    cvs,
    dataDir: getDataDir(),
  });
}
