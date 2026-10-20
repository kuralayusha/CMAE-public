import { NextResponse } from "next/server";
import { getTrackerRevision } from "@/lib/db/revision";
import { t } from "@/lib/i18n/t";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { setItemsActive, setItemsInactive } from "@/lib/tracker/inactive";
import { listTrackerSections } from "@/lib/tracker/list";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      ids?: unknown;
    };
    const action = body.action;
    const ids = Array.isArray(body.ids)
      ? body.ids.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : [];

    if (!ids.length) {
      return NextResponse.json(
        { error: t("tracker.error.bulkIdsRequired") },
        { status: 400 },
      );
    }
    if (action !== "inactive" && action !== "active") {
      return NextResponse.json(
        { error: t("tracker.error.bulkActionInvalid") },
        { status: 400 },
      );
    }

    const result =
      action === "inactive" ? setItemsInactive(ids) : setItemsActive(ids);
    const list = listTrackerSections();
    return NextResponse.json({
      ...result,
      ...list,
      rev: getTrackerRevision(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
