/**
 * Compatibility shim — IMAP mail fetch lives in `@/lib/mail/gmail-imap-source`.
 * Draft helpers remain exported from this path for existing imports.
 */
export {
  WINDOW_DAYS,
  GmailImapSource,
  fetchViaGmailImapSource,
  appendDraft,
  draftExistsBySubject,
  draftSubjectMatchesAny,
  gmailDraftsFolderUrl,
  listRecentDraftSubjectKeys,
  waitForDraftSubject,
  type DraftAttachment,
  type DraftPayload,
  type ImapSyncMode,
} from "@/lib/mail/gmail-imap-source";
