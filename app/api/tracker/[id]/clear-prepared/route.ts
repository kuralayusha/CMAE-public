import { NextResponse } from "next/server";
import { t } from "@/lib/i18n/t";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { clearPreparedMailForItem } from "@/lib/tracker/clear-prepared";
import { ItemOpBusyError, withItemOp } from "@/lib/tracker/item-ops";
import type { DraftKind } from "@/lib/tracker/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const KINDS = ["application", "follow_up", "thanks", "reply"] as const;

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
    const body = (await req.json().catch(() => ({}))) as { kind?: string };
    const kind = body.kind as DraftKind;
    if (!KINDS.includes(kind as (typeof KINDS)[number])) {
      return NextResponse.json(
        { error: t("tracker.error.invalidKind") },
        { status: 400 },
      );
    }
    const result = await withItemOp(id, `clear:${kind}`, () =>
      clearPreparedMailForItem(id, kind),
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ItemOpBusyError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
