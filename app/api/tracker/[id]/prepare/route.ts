import { NextResponse } from "next/server";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { prepareDraftForItem } from "@/lib/tracker/agents/followup";
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
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }
    const body = (await req.json().catch(() => ({}))) as { kind?: string };
    const kind = (body.kind || "follow_up") as Exclude<DraftKind, "application">;
    if (!KINDS.includes(kind as (typeof KINDS)[number])) {
      return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
    }
    const result = await prepareDraftForItem(id, kind);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
