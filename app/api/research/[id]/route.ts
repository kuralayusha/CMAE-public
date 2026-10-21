import { NextResponse } from "next/server";
import { t } from "@/lib/i18n/t";
import { requireOnboardedResponse } from "@/lib/onboarding/http";
import { getJob } from "@/lib/research/events";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const blocked = requireOnboardedResponse();
  if (blocked) return blocked;
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job) {
    return NextResponse.json(
      { error: t("research.error.jobNotFound") },
      { status: 404 },
    );
  }
  return NextResponse.json({
    id: job.id,
    url: job.url,
    status: job.status,
    folderName: job.folderName,
    companyName: job.companyName,
    error: job.error,
  });
}
