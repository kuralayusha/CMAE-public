import { NextResponse } from "next/server";
import { persistEnvCursorKeyIfNeeded } from "@/lib/onboarding/verify";
import { getPublicSettings, updateSettings } from "@/lib/settings/service";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(getPublicSettings());
}

export async function PUT(req: Request) {
  const body = await req.json();
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
    gmailAddress:
      typeof body.gmailAddress === "string" ? body.gmailAddress : undefined,
    gmailAppPassword,
    cursorApiKey,
    followUpDays: body.followUpDays ? Number(body.followUpDays) : undefined,
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
