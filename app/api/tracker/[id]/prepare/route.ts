import { NextResponse } from "next/server";
import { t } from "@/lib/i18n/t";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import {
  prepareApplicationDraftForItem,
  prepareDraftForItem,
} from "@/lib/tracker/agents/followup";
import { createGmailDraftForItem } from "@/lib/tracker/drafts";
import {
  beginDraftOperation,
  endDraftOperation,
} from "@/lib/tracker/draft-inflight";
import {
  getVariantDef,
  normalizeUserNote,
  type DraftPrepareKind,
} from "@/lib/tracker/draft-variants";
import {
  ItemOpBusyError,
  prepareOpKey,
  withItemOp,
} from "@/lib/tracker/item-ops";
import type { DraftKind } from "@/lib/tracker/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const KINDS = ["follow_up", "thanks", "reply"] as const;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  try {
    const { id: idRaw } = await ctx.params;
    const id = Number(idRaw);
    if (!Number.isFinite(id)) {
      return NextResponse.json(
        { error: t("tracker.error.invalidId") },
        { status: 400 },
      );
    }
    const body = (await req.json().catch(() => ({}))) as {
      kind?: string;
      variant?: string;
      userNote?: string;
      eventKinds?: string[];
      threadKey?: string;
    };

    if (body.kind === "application") {
      beginDraftOperation();
      try {
        const result = await withItemOp(id, prepareOpKey("application"), () =>
          prepareApplicationDraftForItem(id),
        );
        let draftError: string | undefined;
        try {
          await createGmailDraftForItem(id, "application");
        } catch (err) {
          console.error("[prepare] gmail draft failed", err);
          draftError = err instanceof Error ? err.message : String(err);
        }
        return NextResponse.json({ ...result, draftError });
      } finally {
        endDraftOperation();
      }
    }

    const kind = (body.kind || "follow_up") as Exclude<DraftKind, "application">;
    if (!KINDS.includes(kind as (typeof KINDS)[number])) {
      return NextResponse.json(
        { error: t("tracker.error.invalidKind") },
        { status: 400 },
      );
    }
    const prepareKind = kind as DraftPrepareKind;
    if (body.variant && !getVariantDef(prepareKind, body.variant)) {
      return NextResponse.json(
        { error: t("tracker.error.invalidVariant") },
        { status: 400 },
      );
    }
    const threadKeyRaw = body.threadKey?.trim() || "";
    const threadKey = /^(t|m):.{1,400}$/.test(threadKeyRaw)
      ? threadKeyRaw
      : undefined;
    const userNote = normalizeUserNote(body.userNote);
    const eventKinds = Array.isArray(body.eventKinds)
      ? body.eventKinds.filter((k): k is string => typeof k === "string")
      : undefined;
    beginDraftOperation();
    try {
      const result = await withItemOp(id, prepareOpKey(kind), () =>
        prepareDraftForItem(id, kind, {
          variant: body.variant,
          userNote,
          eventKinds,
          threadKey,
        }),
      );
      // Save to Gmail Drafts in this request. A second client call was easy
      // to miss, which left only the local file and an orange ring.
      let draftError: string | undefined;
      try {
        await createGmailDraftForItem(id, kind);
      } catch (err) {
        console.error("[prepare] gmail draft failed", err);
        draftError = err instanceof Error ? err.message : String(err);
      }
      return NextResponse.json({ ...result, draftError });
    } finally {
      endDraftOperation();
    }
  } catch (err) {
    if (err instanceof ItemOpBusyError) {
      return NextResponse.json(
        {
          error: err.message,
          code: err.code,
          itemId: err.itemId,
          op: err.op,
          expiresAt: err.expiresAt,
        },
        { status: 409 },
      );
    }
    console.error("[prepare] failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
