import { NextResponse } from "next/server";
import { settingsBusyResponse } from "@/lib/operations/status";
import { persistEnvCursorKeyIfNeeded } from "@/lib/onboarding/verify";
import { t } from "@/lib/i18n/t";
import {
  CLOSE_DAYS_MAX,
  CLOSE_DAYS_MIN,
  getPublicSettings,
  updateSettings,
  wouldSwitchGmailAccount,
} from "@/lib/settings/service";
import {
  executeAccountSwitch,
  previewAccountSwitch,
} from "@/lib/tracker/account-switch";
import { cancelTrackerSyncSession } from "@/lib/sync/engine";
import { getOperationsStatus } from "@/lib/operations/status";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(getPublicSettings());
}

export async function PUT(req: Request) {
  const body = await req.json();
  const gmailAddress =
    typeof body.gmailAddress === "string" ? body.gmailAddress : undefined;
  const confirmAccountSwitch = Boolean(body.confirmAccountSwitch);

  const closeDays = (raw: unknown): number | undefined | null => {
    if (raw == null || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < CLOSE_DAYS_MIN || n > CLOSE_DAYS_MAX) {
      return null;
    }
    return n;
  };
  const rejectionCloseDays = closeDays(body.rejectionCloseDays);
  const staleCloseDays = closeDays(body.staleCloseDays);
  if (rejectionCloseDays === null || staleCloseDays === null) {
    return NextResponse.json(
      {
        error: t("settings.error.closeDaysRange", {
          min: CLOSE_DAYS_MIN,
          max: CLOSE_DAYS_MAX,
        }),
      },
      { status: 400 },
    );
  }

  // K2: different Gmail address requires explicit confirm + wipe.
  if (gmailAddress !== undefined && wouldSwitchGmailAccount(gmailAddress)) {
    const preview = previewAccountSwitch(gmailAddress);
    if (preview.required && !confirmAccountSwitch) {
      return NextResponse.json(
        {
          error: "Account switch confirmation required",
          code: "ACCOUNT_SWITCH_REQUIRED",
          preview,
        },
        { status: 409 },
      );
    }
    if (preview.required && confirmAccountSwitch) {
      await executeAccountSwitch(gmailAddress);
    }
  } else {
    // Same-address credential change: cancel running mail job instead of 409
    // when only gmailSync is busy (research / draft still block).
    const ops = getOperationsStatus();
    if (ops.research || ops.trackerDraft) {
      const busy = settingsBusyResponse();
      if (busy) return busy;
    } else if (ops.gmailSync) {
      cancelTrackerSyncSession();
    } else {
      const busy = settingsBusyResponse();
      if (busy) return busy;
    }
  }

  // Only forward non-empty secrets — never pass null/"" (that used to wipe keys)
  const gmailAppPassword =
    typeof body.gmailAppPassword === "string" && body.gmailAppPassword.trim()
      ? body.gmailAppPassword.trim()
      : undefined;
  const cursorApiKey =
    typeof body.cursorApiKey === "string" && body.cursorApiKey.trim()
      ? body.cursorApiKey.trim()
      : undefined;
  updateSettings({
    fullName: typeof body.fullName === "string" ? body.fullName : undefined,
    gmailAddress,
    gmailAppPassword,
    cursorApiKey,
    followUpDays:
      body.followUpDays != null && body.followUpDays !== ""
        ? Number(body.followUpDays)
        : undefined,
    rejectionCloseDays,
    staleCloseDays,
    preferredLanguage:
      typeof body.preferredLanguage === "string"
        ? body.preferredLanguage
        : undefined,
    emailSignature:
      typeof body.emailSignature === "string" ? body.emailSignature : undefined,
    jobPreferences:
      body.jobPreferences && typeof body.jobPreferences === "object"
        ? body.jobPreferences
        : undefined,
  });
  // Env-only key → copy into SQLite so desktop stays onboarded without .env
  persistEnvCursorKeyIfNeeded();
  return NextResponse.json(getPublicSettings());
}
