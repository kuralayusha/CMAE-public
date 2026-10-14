import { NextResponse } from "next/server";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { cancelJob } from "@/lib/search/cancel";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  const { id } = await ctx.params;
  try {
    const result = await cancelJob(id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 404 },
    );
  }
}
