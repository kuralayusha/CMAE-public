import { NextResponse } from "next/server";
import { getTrackerRevision } from "@/lib/db/revision";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { listTrackerSections } from "@/lib/tracker/list";

export const runtime = "nodejs";
export const maxDuration = 60;

/** validUntil far enough that idle clients get 304; Faz 2 will use nextTransitionAt. */
const VALID_UNTIL_MS = 60_000;

function buildEtag(rev: number, validUntilEpoch: number): string {
  return `W/"r${rev}-v${validUntilEpoch}"`;
}

export async function GET(request: Request) {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  try {
    const rev = getTrackerRevision();
    const serverNow = new Date();
    const validUntil = new Date(serverNow.getTime() + VALID_UNTIL_MS);
    const validUntilEpoch = Math.floor(validUntil.getTime() / 1000);
    const etag = buildEtag(rev, validUntilEpoch);

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
              ETag: etag,
              "Cache-Control": "no-store",
            },
          });
        }
      }
    }

    // Pure read — Gmail Drafts reconcile runs at sync end / after draft create.
    const data = listTrackerSections();
    return NextResponse.json(
      {
        ...data,
        rev,
        serverNow: serverNow.toISOString(),
        validUntil: validUntil.toISOString(),
        freshness: { state: "unknown" as const },
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
