import { NextResponse } from "next/server";
import { getPublicSettings, updateSettings } from "@/lib/settings/service";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(getPublicSettings());
}

export async function PUT(req: Request) {
  const body = await req.json();
  const updated = updateSettings({
    fullName: body.fullName,
    gmailAddress: body.gmailAddress,
    gmailAppPassword: body.gmailAppPassword,
    cursorApiKey: body.cursorApiKey,
    followUpDays: body.followUpDays ? Number(body.followUpDays) : undefined,
    preferredLanguage: body.preferredLanguage,
    emailSignature:
      typeof body.emailSignature === "string" ? body.emailSignature : undefined,
    jobPreferences:
      body.jobPreferences && typeof body.jobPreferences === "object"
        ? body.jobPreferences
        : undefined,
  });
  return NextResponse.json(updated);
}
