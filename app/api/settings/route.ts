import { NextResponse } from "next/server";
import { settingsBusyResponse } from "@/lib/operations/status";
import { persistEnvCursorKeyIfNeeded } from "@/lib/onboarding/verify";
import { t } from "@/lib/i18n/t";
import {
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
import {
  FOLLOW_UP_DAYS_MAX,
  FOLLOW_UP_DAYS_MIN,
  REJECTION_CLOSE_DAYS_MAX,
  REJECTION_CLOSE_DAYS_MIN,
  STALE_CLOSE_DAYS_MAX,
  STALE_CLOSE_DAYS_MIN,
  validateStatusDaySettings,
} from "@/lib/tracker/status-constants";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(getPublicSettings());
}

function dayErrorResponse(code: string) {
  switch (code) {
    case "followUpDaysRange":
      return t("settings.error.followUpDaysRange", {
        min: FOLLOW_UP_DAYS_MIN,
        max: FOLLOW_UP_DAYS_MAX,
      });
    case "rejectionCloseDaysRange":
      return t("settings.error.rejectionCloseDaysRange", {
        min: REJECTION_CLOSE_DAYS_MIN,
        max: REJECTION_CLOSE_DAYS_MAX,
      });
    case "staleCloseDaysRange":
      return t("settings.error.staleCloseDaysRange", {
        min: STALE_CLOSE_DAYS_MIN,
        max: STALE_CLOSE_DAYS_MAX,
      });
    case "followUpBeforeStale":
      return t("settings.error.followUpBeforeStale");
    default:
      return t("settings.error.closeDaysRange", {
        min: STALE_CLOSE_DAYS_MIN,
        max: STALE_CLOSE_DAYS_MAX,
      });
  }
}

export async function PUT(req: Request) {
  const body = await req.json();
  const gmailAddress =
    typeof body.gmailAddress === "string" ? body.gmailAddress : undefined;
  const confirmAccountSwitch = Boolean(body.confirmAccountSwitch);

  const current = getPublicSettings();
  const touchedDays =
    (body.followUpDays != null && body.followUpDays !== "") ||
    (body.rejectionCloseDays != null && body.rejectionCloseDays !== "") ||
    (body.staleCloseDays != null && body.staleCloseDays !== "");
  const dayCheck = touchedDays
    ? validateStatusDaySettings({
        followUpDays:
          body.followUpDays != null && body.followUpDays !== ""
            ? Number(body.followUpDays)
            : current.followUpDays,
        rejectionCloseDays:
          body.rejectionCloseDays != null && body.rejectionCloseDays !== ""
            ? Number(body.rejectionCloseDays)
            : (current.rejectionCloseDays ?? 10),
        staleCloseDays:
          body.staleCloseDays != null && body.staleCloseDays !== ""
            ? Number(body.staleCloseDays)
            : (current.staleCloseDays ?? 20),
      })
    : null;
  if (dayCheck && !dayCheck.ok) {
    return NextResponse.json(
      { error: dayErrorResponse(dayCheck.code), code: dayCheck.code },
      { status: 400 },
    );
  }

  if (
    body.usageTelemetryEnabled !== undefined &&
    typeof body.usageTelemetryEnabled !== "boolean"
  ) {
    return NextResponse.json(
      { error: "usageTelemetryEnabled must be a boolean" },
      { status: 400 },
    );
  }

  // K2: different Gmail address requires explicit confirm + wipe.
  if (gmailAddress !== undefined && wouldSwitchGmailAccount(gmailAddress)) {
    const preview = previewAccountSwitch(gmailAddress);
    if (preview.required && !confirmAccountSwitch) {
      return NextResponse.json(
        {
          error: t("settings.error.accountSwitchRequired"),
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
    followUpDays: dayCheck?.ok ? dayCheck.followUpDays : undefined,
    rejectionCloseDays: dayCheck?.ok ? dayCheck.rejectionCloseDays : undefined,
    staleCloseDays: dayCheck?.ok ? dayCheck.staleCloseDays : undefined,
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
    usageTelemetryEnabled: true,
  });
  // Env-only key → copy into SQLite so desktop stays onboarded without .env
  persistEnvCursorKeyIfNeeded();
  return NextResponse.json(getPublicSettings());
}
