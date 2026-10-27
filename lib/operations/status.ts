import "server-only";

import { NextResponse } from "next/server";
import { t } from "@/lib/i18n/t";
import { getJobs } from "@/lib/research/events";
import { getDraftInflightCount } from "@/lib/tracker/draft-inflight";
import { getActiveSyncSession } from "@/lib/tracker/session";

export type OperationsReason = "gmailSync" | "research" | "trackerDraft";

export type OperationsStatus = {
  gmailSync: boolean;
  research: boolean;
  trackerDraft: boolean;
  busy: boolean;
  reasons: OperationsReason[];
};

/** Live research = queued/running only (error stays in UI but does not lock settings). */
function hasLiveResearch(): boolean {
  for (const job of getJobs().values()) {
    if (job.status === "queued" || job.status === "running") return true;
  }
  return false;
}

export function getOperationsStatus(): OperationsStatus {
  const gmailSync = Boolean(getActiveSyncSession());
  const research = hasLiveResearch();
  const trackerDraft = getDraftInflightCount() > 0;
  const reasons: OperationsReason[] = [];
  if (gmailSync) reasons.push("gmailSync");
  if (research) reasons.push("research");
  if (trackerDraft) reasons.push("trackerDraft");
  return {
    gmailSync,
    research,
    trackerDraft,
    busy: reasons.length > 0,
    reasons,
  };
}

/** 409 when settings mutations would race with research / draft prep. */
export function settingsBusyResponse(): NextResponse | null {
  const status = getOperationsStatus();
  // Gmail sync alone never blocks settings (credential changes cancel it).
  if (!status.research && !status.trackerDraft) return null;
  return NextResponse.json(
    {
      error: t("settings.error.opsBusy"),
      code: "OPS_BUSY",
      ...status,
    },
    { status: 409 },
  );
}
