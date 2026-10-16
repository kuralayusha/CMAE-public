import path from "path";
import { eq } from "drizzle-orm";
import {
  detectSiteLanguageFromFolder,
  pickBestCv,
} from "@/lib/cv/library";
import { getDb } from "@/lib/db/client";
import { trackerItems } from "@/lib/db/schema";
import { getGmailCredentials, getSettingsRow } from "@/lib/settings/service";
import { getWorkspaceRoot } from "@/lib/research/workspace";
import { appendDraft } from "./imap";
import { assertItemActiveForDrafts } from "./inactive";
import {
  findEmailDraftInFolder,
  findNamedDraft,
  type ParsedMailDraft,
} from "./parse-mail-md";
import { replySubject, resolveThreadReplyTarget } from "./reply-thread";
import { FOLLOW_UP_REPEAT_COOLDOWN_DAYS } from "./status";
import type { DraftKind } from "./types";

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
    throw new Error(
      "This row has no workspace folder — research output is required",
    );
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
        ? "email_original.md draft not found"
        : `${kind} draft is not ready yet — use the prepare button first`,
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
    throw new Error("No recipient email address (primaryTo / thread)");
  }

  return { ...draft, to, inReplyTo: null, references: null };
}

export async function createGmailDraftForItem(
  itemId: number,
  kind: DraftKind,
): Promise<{
  gmailUrl: string;
  subject: string;
  to: string;
  attachedCv?: string | null;
  cvWarning?: string | null;
}> {
  const creds = getGmailCredentials();
  if (!creds) {
    throw new Error("Gmail credentials are missing");
  }

  const db = getDb();
  const item = db
    .select()
    .from(trackerItems)
    .where(eq(trackerItems.id, itemId))
    .get();
  if (!item) throw new Error("Tracker item not found");
  assertItemActiveForDrafts(itemId);

  if (kind === "follow_up" && item.status !== "follow_up_due") {
    throw new Error(
      "Follow-up is currently locked — wait 7 days after the last follow-up (or follow-up day has not arrived yet)",
    );
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

  const patch: Partial<typeof trackerItems.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };
  if (kind === "follow_up") {
    const next = new Date();
    next.setDate(next.getDate() + FOLLOW_UP_REPEAT_COOLDOWN_DAYS);
    patch.followUpCount = item.followUpCount + 1;
    patch.hasFollowUpDraft = 0;
    // Block follow-up actions until cooldown; sync will refine from SENT date.
    patch.status = "in_progress";
    patch.waitingOn = "them";
    patch.nextFollowUpAt = next.toISOString();
  }
  if (kind === "thanks") patch.hasThanksDraft = 0;
  if (kind === "reply") patch.hasReplyDraft = 0;

  db.update(trackerItems).set(patch).where(eq(trackerItems.id, itemId)).run();

  return {
    gmailUrl: result.draftsUrl,
    subject: content.subject,
    to: content.to,
    attachedCv,
    cvWarning,
  };
}
