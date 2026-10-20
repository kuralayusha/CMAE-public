import path from "path";
import { eq } from "drizzle-orm";
import {
  detectSiteLanguageFromFolder,
  pickBestCv,
} from "@/lib/cv/library";
import { getDb } from "@/lib/db/client";
import { bumpTrackerRevision } from "@/lib/db/revision";
import { trackerItems } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { getGmailCredentials, getSettingsRow } from "@/lib/settings/service";
import { getWorkspaceRoot } from "@/lib/research/workspace";
import {
  appendDraft,
  draftExistsBySubject,
  gmailDraftsFolderUrl,
  waitForDraftSubject,
} from "./imap";
import { assertItemActiveForDrafts } from "./inactive";
import {
  findEmailDraftInFolder,
  findNamedDraft,
  type ParsedMailDraft,
} from "./parse-mail-md";
import {
  parsePendingGmailDraft,
  reconcilePendingAgainstLiveDrafts,
  withPendingGmailDraft,
} from "./pending-draft";
import { replySubject, resolveThreadReplyTarget } from "./reply-thread";
import type { DraftKind } from "./types";

declare global {
  // eslint-disable-next-line no-var
  var __cmaeDraftItemLocks: Map<string, Promise<unknown>> | undefined;
}

function getDraftItemLocks(): Map<string, Promise<unknown>> {
  if (!globalThis.__cmaeDraftItemLocks) {
    globalThis.__cmaeDraftItemLocks = new Map();
  }
  return globalThis.__cmaeDraftItemLocks;
}

/** Temporary in-memory single-flight lock per (itemId, kind). */
async function withDraftItemLock<T>(
  itemId: number,
  kind: DraftKind,
  fn: () => Promise<T>,
): Promise<T> {
  const locks = getDraftItemLocks();
  const key = `${itemId}:${kind}`;
  const previous = locks.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const tail = previous.then(
    () => gate,
    () => gate,
  );
  locks.set(key, tail);
  try {
    await previous.catch(() => undefined);
    return await fn();
  } finally {
    unlock();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

function markPendingOnItem(
  itemId: number,
  kind: DraftKind,
  subject: string,
  draftsUrl: string,
  at?: string,
): void {
  const db = getDb();
  // Re-read so concurrent notesJson mutations are not overwritten with stale data.
  const fresh = db
    .select()
    .from(trackerItems)
    .where(eq(trackerItems.id, itemId))
    .get();
  if (!fresh) return;
  const patch: Partial<typeof trackerItems.$inferInsert> = {
    notesJson: withPendingGmailDraft(fresh.notesJson, {
      kind,
      at: at || new Date().toISOString(),
      subject,
      draftsUrl,
    }),
  };
  if (kind === "follow_up") patch.hasFollowUpDraft = 0;
  if (kind === "thanks") patch.hasThanksDraft = 0;
  if (kind === "reply") patch.hasReplyDraft = 0;
  db.update(trackerItems)
    .set(patch)
    .where(eq(trackerItems.id, itemId))
    .run();
  bumpTrackerRevision("drafts", "upsert", [itemId]);
}

function folderPathForItem(item: {
  workspaceFolder: string | null;
}): string | null {
  if (!item.workspaceFolder) return null;
  const full = path.join(getWorkspaceRoot(), item.workspaceFolder);
  return full;
}

export function resolveDraftContent(
  item: {
    id: number;
    workspaceFolder: string | null;
    primaryTo: string | null;
    company: string;
    followUpCount: number;
  },
  kind: DraftKind,
  preferredLang?: string,
): ParsedMailDraft & {
  to: string;
  inReplyTo: string | null;
  references: string | null;
} {
  const folder = folderPathForItem(item);
  if (!folder) {
    throw new Error(t("tracker.error.noWorkspaceFolder"));
  }

  let draft: ParsedMailDraft | null = null;
  if (kind === "application") {
    // Pending send: prefer original / site-language draft (email_original.md)
    draft = findEmailDraftInFolder(folder, preferredLang, {
      preferSiteLanguage: true,
    });
  } else if (kind === "follow_up") {
    const n = Math.max(1, item.followUpCount + 1);
    // Prefer original send-language file (never *_translated.md)
    draft =
      findNamedDraft(folder, [
        new RegExp(`^follow_up_${n}\\.md$`, "i"),
        /^follow_up_\d+\.md$/i,
      ]) || null;
  } else if (kind === "thanks") {
    draft = findNamedDraft(folder, [/^thanks\.md$/i, /^tesekkur.*\.md$/i]);
  } else if (kind === "reply") {
    draft = findNamedDraft(folder, [/^reply\.md$/i, /^yanit.*\.md$/i]);
  }

  if (!draft) {
    throw new Error(
      kind === "application"
        ? t("tracker.error.draftMissingOriginal")
        : t("tracker.error.draftNotReady", { kind }),
    );
  }

  // Follow-up / reply / thanks → last SENT or INBOX address + thread headers
  if (kind !== "application") {
    const thread = resolveThreadReplyTarget(item.id);
    if (thread) {
      return {
        ...draft,
        subject: replySubject(draft.subject, thread.anchorSubject),
        to: thread.to,
        inReplyTo: thread.inReplyTo,
        references: thread.references,
      };
    }
  }

  const to = item.primaryTo;
  if (!to) {
    throw new Error(t("tracker.error.noRecipient"));
  }

  return { ...draft, to, inReplyTo: null, references: null };
}

export async function createGmailDraftForItem(
  itemId: number,
  kind: DraftKind,
  opts?: { ensure?: boolean },
): Promise<{
  gmailUrl: string;
  subject: string;
  to: string;
  attachedCv?: string | null;
  cvWarning?: string | null;
  /** true when an existing Drafts message was reused (ensure mode) */
  reused?: boolean;
}> {
  return withDraftItemLock(itemId, kind, async () => {
    const creds = getGmailCredentials();
    if (!creds) {
      throw new Error(t("tracker.error.gmailCredentialsMissing"));
    }

    const db = getDb();
    const item = db
      .select()
      .from(trackerItems)
      .where(eq(trackerItems.id, itemId))
      .get();
    if (!item) throw new Error(t("tracker.error.notFound"));
    assertItemActiveForDrafts(itemId);

    const pending = parsePendingGmailDraft(item.notesJson);
    // Pending reopen may run ensure while still on follow_up_due / rejected / needs_reply
    if (
      kind === "follow_up" &&
      item.status !== "follow_up_due" &&
      !(opts?.ensure && pending?.kind === "follow_up")
    ) {
      throw new Error(t("tracker.error.followUpLocked"));
    }

    const settings = getSettingsRow();
    const content = resolveDraftContent(
      {
        id: item.id,
        workspaceFolder: item.workspaceFolder,
        primaryTo: item.primaryTo,
        company: item.company,
        followUpCount: item.followUpCount,
      },
      kind,
      settings?.preferredLanguage || "en",
    );

    const draftsUrl = gmailDraftsFolderUrl(creds.address);

    // Source of truth: live Gmail Drafts. Never duplicate; clock only after match.
    const alreadyThere = await draftExistsBySubject(
      creds.address,
      creds.appPassword,
      content.subject,
    );
    if (alreadyThere) {
      markPendingOnItem(
        item.id,
        kind,
        content.subject,
        draftsUrl,
        pending?.at,
      );
      await reconcilePendingAgainstLiveDrafts({ force: true }).catch(() => {
        /* best-effort */
      });
      return {
        gmailUrl: draftsUrl,
        subject: content.subject,
        to: content.to,
        reused: true,
      };
    }

    // Missing in Drafts — append, then confirm before marking pending/clock.
    let attachedCv: string | null = null;
    let cvWarning: string | null = null;
    const attachments =
      kind === "application" || kind === "follow_up"
        ? await (async () => {
            const folder = folderPathForItem(item);
            const siteLang = detectSiteLanguageFromFolder(folder);
            const pick = await pickBestCv({
              language: siteLang,
              preferredLanguage: settings?.preferredLanguage || "en",
              position: item.position,
              fullName: settings?.fullName,
            });
            if (!pick) {
              cvWarning = "CV not attached — workspace/cvs/ is empty";
              return undefined;
            }
            attachedCv = pick.entry.label || pick.entry.fileName;
            return [
              {
                filename: pick.attachFileName,
                contentType: "application/pdf",
                buffer: pick.buffer,
              },
            ];
          })()
        : undefined;

    const result = await appendDraft(creds.address, creds.appPassword, {
      from: creds.address,
      to: content.to,
      subject: content.subject,
      body: content.body,
      inReplyTo: content.inReplyTo,
      references: content.references,
      attachments,
    });

    const visible = await waitForDraftSubject(
      creds.address,
      creds.appPassword,
      content.subject,
    );
    if (!visible) {
      throw new Error(t("tracker.error.gmailDraftNotInFolder"));
    }

    // Gmail Drafts ≠ sent: keep status until SENT sync. Clock from live match only.
    markPendingOnItem(item.id, kind, content.subject, result.draftsUrl);

    await reconcilePendingAgainstLiveDrafts({ force: true }).catch(() => {
      /* best-effort */
    });

    return {
      gmailUrl: result.draftsUrl,
      subject: content.subject,
      to: content.to,
      attachedCv,
      cvWarning,
      reused: false,
    };
  });
}
