/**
 * Gmail Drafts ≠ sent. Track pending drafts in notesJson until SENT sync.
 * Pending is a cache — live Drafts folder is the source of truth on list load.
 */

import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { trackerItems } from "@/lib/db/schema";
import { getWorkspaceRoot } from "@/lib/research/workspace";
import { getGmailCredentials } from "@/lib/settings/service";
import {
  draftSubjectMatchesAny,
  listRecentDraftSubjectKeys,
} from "./imap";
import type { DraftKind } from "./types";

export type PendingGmailDraft = {
  kind: Exclude<DraftKind, "application">;
  at: string;
  subject: string;
  /** Gmail Drafts folder URL (authuser) — open on pending click */
  draftsUrl?: string;
};

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
  if (kind !== "follow_up" && kind !== "thanks" && kind !== "reply") {
    return null;
  }
  const at = typeof obj.at === "string" ? obj.at : "";
  const subject = typeof obj.subject === "string" ? obj.subject : "";
  const draftsUrl =
    typeof obj.draftsUrl === "string" && obj.draftsUrl.trim()
      ? obj.draftsUrl.trim()
      : undefined;
  if (!at) return null;
  return { kind, at, subject, draftsUrl };
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

function folderPath(workspaceFolder: string | null): string | null {
  if (!workspaceFolder) return null;
  const full = path.join(getWorkspaceRoot(), workspaceFolder);
  if (!fs.existsSync(full)) return null;
  return full;
}

function listMdNames(folder: string): string[] {
  try {
    return fs
      .readdirSync(folder)
      .filter((n) => n.toLowerCase().endsWith(".md"));
  } catch {
    return [];
  }
}

export function draftFlagsFromDisk(
  workspaceFolder: string | null,
  followUpCount: number,
): DraftFlagsOnDisk {
  const folder = folderPath(workspaceFolder);
  if (!folder) {
    return {
      hasFollowUpDraft: false,
      hasThanksDraft: false,
      hasReplyDraft: false,
    };
  }
  const names = listMdNames(folder);
  const n = Math.max(1, (followUpCount || 0) + 1);
  const hasFollowUpDraft = names.some(
    (f) =>
      new RegExp(`^follow_up_${n}\\.md$`, "i").test(f) ||
      /^follow_up_\d+\.md$/i.test(f),
  );
  const hasThanksDraft = names.some(
    (f) => /^thanks\.md$/i.test(f) || /^tesekkur.*\.md$/i.test(f),
  );
  const hasReplyDraft = names.some(
    (f) => /^reply\.md$/i.test(f) || /^yanit.*\.md$/i.test(f),
  );
  return { hasFollowUpDraft, hasThanksDraft, hasReplyDraft };
}

/**
 * Align DB has*Draft flags with workspace files (prepare may finish while UI is away).
 * Does not clear flags when pendingGmailDraft is set (md still on disk but already pushed to Gmail).
 */
export function reconcileDraftFlagsForRow(row: {
  id: number;
  workspaceFolder: string | null;
  followUpCount: number;
  notesJson: string | null;
  hasFollowUpDraft: number | boolean;
  hasThanksDraft: number | boolean;
  hasReplyDraft: number | boolean;
}): {
  hasFollowUpDraft: boolean;
  hasThanksDraft: boolean;
  hasReplyDraft: boolean;
} {
  const pending = parsePendingGmailDraft(row.notesJson);
  const disk = draftFlagsFromDisk(row.workspaceFolder, row.followUpCount);

  // If Gmail draft already created, keep has* false even if md remains on disk
  let hasFollowUpDraft = Boolean(row.hasFollowUpDraft) || disk.hasFollowUpDraft;
  let hasThanksDraft = Boolean(row.hasThanksDraft) || disk.hasThanksDraft;
  let hasReplyDraft = Boolean(row.hasReplyDraft) || disk.hasReplyDraft;

  if (pending?.kind === "follow_up") hasFollowUpDraft = false;
  if (pending?.kind === "thanks") hasThanksDraft = false;
  if (pending?.kind === "reply") hasReplyDraft = false;

  const dbFu = Boolean(row.hasFollowUpDraft);
  const dbTh = Boolean(row.hasThanksDraft);
  const dbRe = Boolean(row.hasReplyDraft);

  if (
    hasFollowUpDraft !== dbFu ||
    hasThanksDraft !== dbTh ||
    hasReplyDraft !== dbRe
  ) {
    getDb()
      .update(trackerItems)
      .set({
        hasFollowUpDraft: hasFollowUpDraft ? 1 : 0,
        hasThanksDraft: hasThanksDraft ? 1 : 0,
        hasReplyDraft: hasReplyDraft ? 1 : 0,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(trackerItems.id, row.id))
      .run();
  }

  return { hasFollowUpDraft, hasThanksDraft, hasReplyDraft };
}

/** Merge helper for sync notes objects. */
export function clearPendingFromNotesObj(
  notesObj: Record<string, unknown>,
): void {
  delete notesObj.pendingGmailDraft;
}

let lastLiveReconcileAt = 0;
const LIVE_RECONCILE_MIN_MS = 12_000;

/**
 * Clear pendingGmailDraft when the matching message is gone from Gmail Drafts
 * (user deleted it). Restores has*Draft from workspace .md so Prepare/Create
 * draft actions return. Debounced so visibility+double load do not spam IMAP.
 */
export async function reconcilePendingAgainstLiveDrafts(opts?: {
  force?: boolean;
}): Promise<{ checked: number; cleared: number }> {
  const now = Date.now();
  if (
    !opts?.force &&
    lastLiveReconcileAt &&
    now - lastLiveReconcileAt < LIVE_RECONCILE_MIN_MS
  ) {
    return { checked: 0, cleared: 0 };
  }

  const db = getDb();
  const rows = db.select().from(trackerItems).all();
  const pendingRows = rows
    .map((row) => ({ row, pending: parsePendingGmailDraft(row.notesJson) }))
    .filter(
      (x): x is { row: (typeof rows)[number]; pending: PendingGmailDraft } =>
        Boolean(x.pending?.subject),
    );

  if (!pendingRows.length) {
    lastLiveReconcileAt = now;
    return { checked: 0, cleared: 0 };
  }

  const creds = getGmailCredentials();
  if (!creds) {
    return { checked: pendingRows.length, cleared: 0 };
  }

  let draftKeys: string[] = [];
  try {
    draftKeys = await listRecentDraftSubjectKeys(
      creds.address,
      creds.appPassword,
    );
  } catch {
    // IMAP failure — keep pending cache; do not wipe on network blip
    return { checked: pendingRows.length, cleared: 0 };
  }

  lastLiveReconcileAt = Date.now();
  let cleared = 0;

  for (const { row, pending } of pendingRows) {
    if (draftSubjectMatchesAny(pending.subject, draftKeys)) continue;

    const nextNotes = withoutPendingGmailDraft(row.notesJson);
    db.update(trackerItems)
      .set({
        notesJson: nextNotes,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(trackerItems.id, row.id))
      .run();

    // Re-enable prepare / create-draft from disk now that Gmail draft is gone
    reconcileDraftFlagsForRow({
      ...row,
      notesJson: nextNotes,
      hasFollowUpDraft: 0,
      hasThanksDraft: 0,
      hasReplyDraft: 0,
    });
    cleared += 1;
  }

  return { checked: pendingRows.length, cleared };
}
