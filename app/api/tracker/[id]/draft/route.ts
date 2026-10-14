import { NextResponse } from "next/server";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
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
      return NextResponse.json({ error: "Geçersiz id" }, { status: 400 });
    }
    const body = (await req.json().catch(() => ({}))) as { kind?: string };
    const kind = (body.kind || "application") as DraftKind;
    if (!KINDS.includes(kind)) {
      return NextResponse.json({ error: "Geçersiz kind" }, { status: 400 });
    }
    const result = await createGmailDraftForItem(id, kind);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
