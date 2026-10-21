import { NextResponse } from "next/server";
import { t } from "@/lib/i18n/t";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { cancelTrackerSyncSession, getSyncSession } from "@/lib/tracker/session";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  const { id } = await ctx.params;
  if (!getSyncSession(id)) {
    return NextResponse.json(
      { error: t("sync.sessionNotFound") },
      { status: 404 },
    );
  }
  const session = cancelTrackerSyncSession(id);
  return NextResponse.json({
    id: session?.id,
    status: session?.status,
  });
}
