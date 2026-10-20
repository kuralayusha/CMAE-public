import { NextResponse } from "next/server";
import { t } from "@/lib/i18n/t";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import {
  beginDraftOperation,
  endDraftOperation,
} from "@/lib/tracker/draft-inflight";
import { createGmailDraftForItem } from "@/lib/tracker/drafts";
import type { DraftKind } from "@/lib/tracker/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const KINDS: DraftKind[] = ["application", "follow_up", "thanks", "reply"];

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
      /** Reopen pending: reuse Drafts if present, else recreate from .md */
      ensure?: boolean;
    };
    const kind = (body.kind || "application") as DraftKind;
    if (!KINDS.includes(kind)) {
      return NextResponse.json(
        { error: t("tracker.error.invalidKind") },
        { status: 400 },
      );
    }
    beginDraftOperation();
    try {
      const result = await createGmailDraftForItem(id, kind, {
        ensure: Boolean(body.ensure),
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
