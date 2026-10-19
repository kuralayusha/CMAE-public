import { NextResponse } from "next/server";
import { t } from "@/lib/i18n/t";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import {
  loadItemGmailUrls,
  loadLinkedMails,
  loadTrackerItem,
} from "@/lib/tracker/timeline";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;

  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isFinite(id)) {
    return NextResponse.json(
      { error: t("tracker.error.invalidId") },
      { status: 400 },
    );
  }

  const item = loadTrackerItem(id);
  if (!item) {
    return NextResponse.json(
      { error: t("tracker.error.notFound") },
      { status: 404 },
    );
  }

  const mails = loadLinkedMails(id);
  const gmailUrls = loadItemGmailUrls(mails);

  return NextResponse.json({
    item,
    mails: mails.map((m) => ({
      id: m.id,
      folder: m.folder,
      role: m.role,
      fromAddr: m.fromAddr,
      toAddr: m.toAddr,
      subject: m.subject,
      dateIso: m.dateIso,
      snippet: m.snippet,
      gmailUrl: m.gmailUrl,
    })),
    gmailUrls,
  });
}
