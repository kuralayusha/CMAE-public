import { NextResponse } from "next/server";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { listJobsForUi, parseUrls, startResearchJobs } from "@/lib/research/jobs";

export const runtime = "nodejs";

export async function GET() {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  const { active, history } = listJobsForUi();
  return NextResponse.json({ active, history, jobs: active });
}

export async function POST(req: Request) {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  try {
    const body = await req.json();
    const raw = String(body.urls || body.url || "");
    const urls = parseUrls(raw);
    if (!urls.length) {
      return NextResponse.json({ error: "At least one link is required" }, { status: 400 });
    }
    if (urls.length > 20) {
      return NextResponse.json({ error: "Maximum 20 links" }, { status: 400 });
    }

    const jobs = startResearchJobs(urls);
    return NextResponse.json({
      jobs: jobs.map((j) => ({
        id: j.id,
        url: j.url,
        status: j.status,
        folderName: j.folderName,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
