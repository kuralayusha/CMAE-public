import { NextResponse } from "next/server";
import { t } from "@/lib/i18n/t";
import {
  getOnboardingGaps,
  isOnboardingComplete,
  markOnboardingComplete,
} from "@/lib/onboarding/status";
import { persistEnvCursorKeyIfNeeded } from "@/lib/onboarding/verify";
import { getGmailCredentials, updateSettings } from "@/lib/settings/service";
import { wakeScheduler } from "@/lib/sync/scheduler";

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
          error: t("onboarding.error.requiredFields"),
          gaps,
        },
        { status: 400 },
      );
    }

    const at = markOnboardingComplete();

    // Scheduler may have started before onboarding — wake starts IDLE + sync
    // only when Gmail creds are present (avoids Phase C gmailMissing). Soft
    // 60s coalesce prevents a second empty sync if creds-save already synced.
    if (getGmailCredentials()) {
      try {
        wakeScheduler({ reason: "wake" });
      } catch {
        /* best-effort */
      }
    }

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
