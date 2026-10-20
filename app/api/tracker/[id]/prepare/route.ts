import { NextResponse } from "next/server";
import { t } from "@/lib/i18n/t";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { prepareDraftForItem } from "@/lib/tracker/agents/followup";
import {
  beginDraftOperation,
  endDraftOperation,
} from "@/lib/tracker/draft-inflight";
import {
  getVariantDef,
  normalizeUserNote,
  type DraftPrepareKind,
} from "@/lib/tracker/draft-variants";
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
    };
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
    const userNote = normalizeUserNote(body.userNote);
    const eventKinds = Array.isArray(body.eventKinds)
      ? body.eventKinds.filter((k): k is string => typeof k === "string")
      : undefined;
    beginDraftOperation();
    try {
      const result = await prepareDraftForItem(id, kind, {
        variant: body.variant,
        userNote,
        eventKinds,
      });
      return NextResponse.json(result);
    } finally {
      endDraftOperation();
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
