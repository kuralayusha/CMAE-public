import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { trackerItems } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { loadRecipientsForItem } from "@/lib/tracker/recipients";
import { setTrackerItemRecipient } from "@/lib/tracker/set-recipient";
import {
  ItemGoneError,
  MaintenanceError,
  MutationConflictError,
} from "@/lib/tracker/item-tx";
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

  const raw = getDb()
    .select()
    .from(trackerItems)
    .where(eq(trackerItems.id, id))
    .get();

  if (!raw) {
    return NextResponse.json(
      { error: t("tracker.error.notFound") },
      { status: 404 },
    );
  }

  if (raw.mergedIntoId != null || raw.deletedReason === "merged") {
    return NextResponse.json(
      {
        error: t("tracker.error.itemMerged"),
        code: "ITEM_GONE",
        reason: "merged",
        mergedIntoId: raw.mergedIntoId,
        deletedReason: raw.deletedReason,
      },
      { status: 410 },
    );
  }

  if (raw.deletedAt) {
    return NextResponse.json(
      {
        error: t("tracker.error.itemDeleted"),
        code: "ITEM_GONE",
        reason: "deleted",
        deletedReason: raw.deletedReason,
      },
      { status: 410 },
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
  const recipients = loadRecipientsForItem(raw);

  return NextResponse.json({
    item: {
      ...item,
      userVersion: raw.userVersion || 1,
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

  let body: { primaryTo?: unknown; expectUserVersion?: unknown };
  try {
    body = (await req.json()) as {
      primaryTo?: unknown;
      expectUserVersion?: unknown;
    };
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

  const expectUserVersion =
    typeof body.expectUserVersion === "number" &&
    Number.isFinite(body.expectUserVersion)
      ? body.expectUserVersion
      : undefined;

  try {
    const result = setTrackerItemRecipient(id, body.primaryTo, {
      expectUserVersion,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MutationConflictError) {
      return NextResponse.json(
        {
          error: err.message,
          code: err.code,
          current: err.current,
        },
        { status: 409 },
      );
    }
    if (err instanceof ItemGoneError) {
      return NextResponse.json(
        {
          error: err.message,
          code: err.code,
          reason: err.reason,
          mergedIntoId: err.mergedIntoId,
          deletedReason: err.deletedReason,
        },
        { status: 410 },
      );
    }
    if (err instanceof MaintenanceError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 503 },
      );
    }
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
