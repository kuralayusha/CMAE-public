import { NextResponse } from "next/server";
import { t } from "@/lib/i18n/t";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import {
  listPendingMergeProposals,
  respondMergeProposal,
} from "@/lib/tracker/merge-proposals";

export const runtime = "nodejs";

export async function GET() {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  try {
    return NextResponse.json({
      proposals: listPendingMergeProposals(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      id?: string;
      decision?: string;
      choices?: Record<string, string | null>;
    };
    if (!body.id || typeof body.id !== "string") {
      return NextResponse.json(
        { error: t("tracker.error.mergeNotFound") },
        { status: 400 },
      );
    }
    if (body.decision !== "accept" && body.decision !== "reject") {
      return NextResponse.json(
        { error: t("tracker.error.mergeDecisionInvalid") },
        { status: 400 },
      );
    }
    const result = respondMergeProposal(body.id, {
      decision: body.decision,
      choices: body.choices,
    });
    if (!result.ok) {
      const status =
        result.state === "stale" || result.state === "missing" ? 409 : 400;
      return NextResponse.json(result, { status });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
