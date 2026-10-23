import path from "path";
import { eq } from "drizzle-orm";
import {
  detectSiteLanguageFromFolder,
  pickBestCv,
} from "@/lib/cv/library";
import { normalizeAccountId } from "@/lib/db/app-meta";
import { getDb } from "@/lib/db/client";
import { trackerItems } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import { getWorkspaceRoot } from "@/lib/research/workspace";
import { getGmailCredentials, getSettingsRow } from "@/lib/settings/service";
import { searchDraftByMessageId } from "@/lib/mail/gmail-imap-source";
import { appendDraft, gmailDraftsFolderUrl } from "./imap";
import { assertItemActiveForDrafts } from "./inactive";
import { rescanWorkspaceFolder } from "./workspace-index";
import {
  clearHasDraftFlagsForKind,
  contentHashForDraft,
  getLiveDraftForItem,
  insertCreatingDraft,
  markDraftDeletedByUser,
  markDraftFailed,
  markDraftPresent,
  waitForDraftSettled,
} from "./gmail-drafts-store";
import {
  findEmailDraftInFolder,
  findNamedDraft,
  type ParsedMailDraft,
} from "./parse-mail-md";
import { parseReplyThreadKey } from "./reply-thread-key";
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

function folderPathForItem(item: {
  workspaceFolder: string | null;
}): string | null {
  if (!item.workspaceFolder) return null;
  return path.join(getWorkspaceRoot(), item.workspaceFolder);
}

function triggerDraftsReconcile(): void {
  void import("@/lib/sync/engine")
    .then((m) => m.enqueueDraftsReconcile("post_mutation"))
    .catch(() => {
      /* best-effort */
    });
}

export function resolveDraftContent(
  item: {
    id: number;
    workspaceFolder: string | null;
    primaryTo: string | null;
    company: string;
    followUpCount: number;
    notesJson?: string | null;
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
    draft = findEmailDraftInFolder(folder, preferredLang, {
      preferSiteLanguage: true,
    });
  } else if (kind === "follow_up") {
    const n = Math.max(1, item.followUpCount + 1);
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

  if (kind !== "application") {
    const thread = resolveThreadReplyTarget(
      item.id,
      parseReplyThreadKey(item.notesJson, kind),
    );
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
  /** true when an existing Drafts message was reused (ensure / unique live) */
  reused?: boolean;
  draftId?: string;
  state?: string;
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

    const live = getLiveDraftForItem(itemId, kind);
    if (
      kind === "follow_up" &&
      item.status !== "follow_up_due" &&
      !(opts?.ensure && live?.kind === "follow_up")
    ) {
      throw new Error(t("tracker.error.followUpLocked"));
    }

    const draftsUrl = gmailDraftsFolderUrl(creds.address);

    // Exactly-once: unique live index — return existing without second APPEND.
    // On ensure (user opens "Gmail Drafts"), verify the message is still there;
    // if they deleted it in Gmail, clear live state and recreate below.
    if (
      live &&
      (live.state === "creating" ||
        live.state === "present" ||
        live.state === "unknown")
    ) {
      let row = live;
      // Another request may still be APPENDing — never hand back "creating".
      if (row.state === "creating") {
        const settled = await waitForDraftSettled(row.id);
        if (!settled || settled.state === "creating") {
          throw new Error(t("tracker.error.gmailDraftStillCreating"));
        }
        row = settled;
      }

      if (row.state === "present" || row.state === "unknown") {
        let stillLive = true;
        if (
          opts?.ensure &&
          row.messageIdHdr &&
          !row.messageIdHdr.startsWith("legacy:")
        ) {
          try {
            const found = await searchDraftByMessageId(
              creds.address,
              creds.appPassword,
              row.messageIdHdr,
            );
            if (!found) {
              markDraftDeletedByUser(row.id);
              stillLive = false;
            }
          } catch {
            /* IMAP blip — keep live row, open Drafts folder */
          }
        }
        if (stillLive) {
          triggerDraftsReconcile();
          return {
            gmailUrl: draftsUrl,
            subject: row.subject,
            to: row.toAddr,
            reused: true,
            draftId: row.id,
            state: row.state,
          };
        }
      }
    }

    const settings = getSettingsRow();
    const content = resolveDraftContent(
      {
        id: item.id,
        workspaceFolder: item.workspaceFolder,
        primaryTo: item.selectedRecipient || item.primaryTo,
        company: item.company,
        followUpCount: item.followUpCount,
        notesJson: item.notesJson,
      },
      kind,
      settings?.preferredLanguage || "en",
    );

    const hash = contentHashForDraft({
      subject: content.subject,
      to: content.to,
      body: content.body,
    });

    const { row, created } = insertCreatingDraft({
      itemId: item.id,
      accountId: normalizeAccountId(creds.address),
      kind,
      subject: content.subject,
      toAddr: content.to,
      contentHash: hash,
    });

    // Index hash includes the recipient; refresh it now that the live draft's
    // To is known, otherwise the row shows a false "differs from Gmail" warning.
    if (created && item.workspaceFolder) {
      try {
        rescanWorkspaceFolder(item.workspaceFolder);
      } catch {
        /* index refresh is best-effort */
      }
    }

    if (!created) {
      // Parallel POST lost the race — wait for winner's APPEND to finish.
      const settled = await waitForDraftSettled(row.id);
      if (!settled || settled.state === "creating") {
        throw new Error(t("tracker.error.gmailDraftStillCreating"));
      }
      if (settled.state === "failed") {
        throw new Error(settled.error || t("tracker.error.gmailDraft"));
      }
      if (settled.state === "present" || settled.state === "unknown") {
        triggerDraftsReconcile();
        return {
          gmailUrl: draftsUrl,
          subject: settled.subject,
          to: settled.toAddr,
          reused: true,
          draftId: settled.id,
          state: settled.state,
        };
      }
      // deleted / superseded — fall through is unreachable (unique live gone);
      // re-enter by throwing so the client can retry.
      throw new Error(t("tracker.error.gmailDraft"));
    }

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

    try {
      const result = await appendDraft(creds.address, creds.appPassword, {
        from: creds.address,
        to: content.to,
        subject: content.subject,
        body: content.body,
        inReplyTo: content.inReplyTo,
        references: content.references,
        attachments,
        messageId: row.messageIdHdr,
        draftId: row.id,
      });

      markDraftPresent(row.id, {
        gmMsgid: result.gmMsgid,
        gmThrid: result.gmThrid,
        draftsUid: result.uid,
        draftsUidvalidity: result.uidValidity,
        subject: content.subject,
        toAddr: content.to,
      });
      clearHasDraftFlagsForKind(item.id, kind);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      markDraftFailed(row.id, msg);
      throw err;
    }

    // Confirm / recover identity via job (crash-safe if process dies after APPEND).
    triggerDraftsReconcile();

    return {
      gmailUrl: draftsUrl,
      subject: content.subject,
      to: content.to,
      attachedCv,
      cvWarning,
      reused: false,
      draftId: row.id,
      state: "present",
    };
  });
}
