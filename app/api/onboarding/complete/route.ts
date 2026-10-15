import { NextResponse } from "next/server";
import {
  getOnboardingGaps,
  isOnboardingComplete,
  markOnboardingComplete,
} from "@/lib/onboarding/status";
import { persistEnvCursorKeyIfNeeded } from "@/lib/onboarding/verify";
import { updateSettings } from "@/lib/settings/service";

export const runtime = "nodejs";

/**
 * Saves any final payload, validates required fields, then sets onboarding flag.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    if (body && typeof body === "object" && Object.keys(body).length > 0) {
      updateSettings({
        fullName: typeof body.fullName === "string" ? body.fullName : undefined,
        gmailAddress:
          typeof body.gmailAddress === "string" ? body.gmailAddress : undefined,
        gmailAppPassword:
          typeof body.gmailAppPassword === "string"
            ? body.gmailAppPassword
            : undefined,
        cursorApiKey:
          typeof body.cursorApiKey === "string" ? body.cursorApiKey : undefined,
        followUpDays:
          body.followUpDays != null ? Number(body.followUpDays) : undefined,
        preferredLanguage:
          typeof body.preferredLanguage === "string"
            ? body.preferredLanguage
            : undefined,
        emailSignature:
          typeof body.emailSignature === "string"
            ? body.emailSignature
            : undefined,
        jobPreferences:
          body.jobPreferences && typeof body.jobPreferences === "object"
            ? (body.jobPreferences as Parameters<
                typeof updateSettings
              >[0]["jobPreferences"])
            : undefined,
      });
    }

    // Env-only Cursor key would leave a gap after restart / packaged app
    persistEnvCursorKeyIfNeeded();

    const gaps = getOnboardingGaps();
    if (gaps.length) {
      return NextResponse.json(
        {
          error: "Required fields are missing",
          gaps,
        },
        { status: 400 },
      );
    }

    const at = markOnboardingComplete();
    return NextResponse.json({
      ok: true,
      onboardingCompletedAt: at,
      complete: isOnboardingComplete(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
