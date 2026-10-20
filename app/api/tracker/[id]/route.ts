import { NextResponse } from "next/server";
import { t } from "@/lib/i18n/t";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { loadRecipientsForItem } from "@/lib/tracker/recipients";
import { setTrackerItemRecipient } from "@/lib/tracker/set-recipient";
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
  const recipients = loadRecipientsForItem(item);

  return NextResponse.json({
    item: {
      ...item,
      recipientOptions: recipients.candidates,
      recommendedTo: recipients.recommended,
    },
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
      goneAt: m.goneAt,
      goneReason: m.goneReason,
    })),
    gmailUrls,
  });
}

export async function PATCH(
  req: Request,
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

  let body: { primaryTo?: unknown };
  try {
    body = (await req.json()) as { primaryTo?: unknown };
  } catch {
    return NextResponse.json(
      { error: t("tracker.error.invalidBody") },
      { status: 400 },
    );
  }

  if (typeof body.primaryTo !== "string" || !body.primaryTo.trim()) {
    return NextResponse.json(
      { error: t("tracker.error.invalidRecipient") },
      { status: 400 },
    );
  }

  try {
    const result = setTrackerItemRecipient(id, body.primaryTo);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      message === t("tracker.error.notFound")
        ? 404
        : message === t("tracker.error.recipientNotInCandidates") ||
            message === t("tracker.error.invalidRecipient")
          ? 400
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
