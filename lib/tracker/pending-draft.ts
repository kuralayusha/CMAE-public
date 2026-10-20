/**
 * Gmail Drafts ≠ sent. Pending UX reads gmail_drafts (Faz 5).
 * Legacy notesJson.pendingGmailDraft helpers kept for derive/migration.
 * IMAP reconcile lives in drafts-reconcile.ts — never on GET /api/tracker.
 * Draft flags: workspace_files index (Faz 7), not direct fs on GET.
 */

import { getLiveDraftAnyKind } from "./gmail-drafts-store";
import { draftFlagsFromIndex } from "./workspace-index";
import type { DraftKind, TrackerStatus } from "./types";

/** Status → which Gmail draft kind can be pending for the clock. */
export function expectedPendingKindForStatus(
  status: string,
): DraftKind | null {
  switch (status as TrackerStatus) {
    case "ready_to_send":
      return "application";
    case "follow_up_due":
      return "follow_up";
    case "rejected":
      return "thanks";
    case "needs_reply":
    case "in_progress":
      return "reply";
    default:
      return null;
  }
}

export type PendingGmailDraft = {
  kind: DraftKind;
  at: string;
  subject: string;
  /** Gmail Drafts folder URL (authuser) — open on pending click */
  draftsUrl?: string;
};

const PENDING_KINDS: DraftKind[] = [
  "application",
  "follow_up",
  "thanks",
  "reply",
];

export type DraftFlagsOnDisk = {
  hasFollowUpDraft: boolean;
  hasThanksDraft: boolean;
  hasReplyDraft: boolean;
};

function parseNotes(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

export function parsePendingGmailDraft(
  notesJson: string | null | undefined,
): PendingGmailDraft | null {
  const notes = parseNotes(notesJson);
  const raw = notes.pendingGmailDraft;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
  if (typeof kind !== "string" || !PENDING_KINDS.includes(kind as DraftKind)) {
    return null;
  }
  const at = typeof obj.at === "string" ? obj.at : "";
  const subject = typeof obj.subject === "string" ? obj.subject : "";
  const draftsUrl =
    typeof obj.draftsUrl === "string" && obj.draftsUrl.trim()
      ? obj.draftsUrl.trim()
      : undefined;
  if (!at) return null;
  return { kind: kind as DraftKind, at, subject, draftsUrl };
}

export function withPendingGmailDraft(
  notesJson: string | null | undefined,
  pending: PendingGmailDraft,
): string {
  const notes = parseNotes(notesJson);
  notes.pendingGmailDraft = pending;
  return JSON.stringify(notes);
}

export function withoutPendingGmailDraft(
  notesJson: string | null | undefined,
): string {
  const notes = parseNotes(notesJson);
  delete notes.pendingGmailDraft;
  return JSON.stringify(notes);
}

/** Clear pending once a SENT mail newer than the draft timestamp is known. */
export function shouldClearPendingGmailDraft(
  pending: PendingGmailDraft | null,
  lastOutboundAt: string | null,
): boolean {
  if (!pending) return false;
  if (!lastOutboundAt) return false;
  const out = Date.parse(lastOutboundAt);
  const at = Date.parse(pending.at);
  if (Number.isNaN(out) || Number.isNaN(at)) return false;
  return out >= at;
}

/** @deprecated Prefer draftFlagsFromIndex — kept name for call sites. */
export function draftFlagsFromDisk(
  workspaceFolder: string | null,
  followUpCount: number,
): DraftFlagsOnDisk {
  return draftFlagsFromIndex(workspaceFolder, followUpCount);
}

/**
 * Draft flags from workspace_files index + live gmail_drafts (Faz 8: no DB columns).
 * `persist` is ignored (kept for call-site compatibility).
 */
export function reconcileDraftFlagsForRow(
  row: {
    id: number;
    workspaceFolder: string | null;
    followUpCount: number;
    notesJson: string | null;
    hasFollowUpDraft?: number | boolean;
    hasThanksDraft?: number | boolean;
    hasReplyDraft?: number | boolean;
  },
  _opts?: { persist?: boolean },
): {
  hasFollowUpDraft: boolean;
  hasThanksDraft: boolean;
  hasReplyDraft: boolean;
} {
  const live = getLiveDraftAnyKind(row.id);
  const pending = live
    ? { kind: live.kind as DraftKind }
    : parsePendingGmailDraft(row.notesJson);
  const indexed = draftFlagsFromIndex(row.workspaceFolder, row.followUpCount);

  let hasFollowUpDraft = indexed.hasFollowUpDraft;
  let hasThanksDraft = indexed.hasThanksDraft;
  let hasReplyDraft = indexed.hasReplyDraft;

  // Live Gmail draft for that kind → not "pending local draft"
  if (pending?.kind === "follow_up") hasFollowUpDraft = false;
  if (pending?.kind === "thanks") hasThanksDraft = false;
  if (pending?.kind === "reply") hasReplyDraft = false;

  return { hasFollowUpDraft, hasThanksDraft, hasReplyDraft };
}

/** Merge helper for sync notes objects. */
export function clearPendingFromNotesObj(
  notesObj: Record<string, unknown>,
): void {
  delete notesObj.pendingGmailDraft;
}

