import { NextResponse } from "next/server";
import { getTrackerRevision } from "@/lib/db/revision";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { computeTrackerFreshness } from "@/lib/sync/freshness";
import { listActiveItemOps } from "@/lib/tracker/item-ops";
import { listTrackerSections } from "@/lib/tracker/list";

export const runtime = "nodejs";
export const maxDuration = 60;

/** validUntil far enough that idle clients get 304; capped by the next status transition. */
const VALID_UNTIL_MS = 60_000;
const VALID_UNTIL_MIN_MS = 1_000;

function buildEtag(rev: number, validUntilEpoch: number): string {
  return `W/"r${rev}-v${validUntilEpoch}"`;
}

export async function GET(request: Request) {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  try {
    const rev = getTrackerRevision();
    const serverNow = new Date();

    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch) {
      // Accept weak match on revision prefix so clock skew on validUntil still 304s
      // when the list revision is unchanged and validUntil has not expired.
      const m = /W\/"r(\d+)-v(\d+)"/.exec(ifNoneMatch.trim());
      if (m) {
        const clientRev = Number.parseInt(m[1]!, 10);
        const clientValidUntil = Number.parseInt(m[2]!, 10);
        const nowEpoch = Math.floor(serverNow.getTime() / 1000);
        if (
          clientRev === rev &&
          Number.isFinite(clientValidUntil) &&
          nowEpoch < clientValidUntil
        ) {
          return new NextResponse(null, {
            status: 304,
            headers: {
              ETag: buildEtag(clientRev, clientValidUntil),
              "Cache-Control": "no-store",
            },
          });
        }
      }
    }

    // Pure read — Gmail Drafts reconcile runs at sync end / after draft create.
    const data = listTrackerSections({ now: serverNow.getTime() });
    const transitionMs = data.nextTransitionAt
      ? Date.parse(data.nextTransitionAt)
      : Number.POSITIVE_INFINITY;
    const validUntil = new Date(
      Math.max(
        serverNow.getTime() + VALID_UNTIL_MIN_MS,
        Math.min(serverNow.getTime() + VALID_UNTIL_MS, transitionMs),
      ),
    );
    const etag = buildEtag(rev, Math.floor(validUntil.getTime() / 1000));
    return NextResponse.json(
      {
        ...data,
        rev,
        serverNow: serverNow.toISOString(),
        validUntil: validUntil.toISOString(),
        freshness: computeTrackerFreshness(serverNow),
        itemOps: listActiveItemOps(),
      },
      {
        headers: {
          ETag: etag,
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
