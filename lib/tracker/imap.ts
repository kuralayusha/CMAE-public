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
  listAllDraftMetas,
  listRecentDraftSubjectKeys,
  searchDraftByMessageId,
  waitForDraftSubject,
  type AppendDraftResult,
  type DraftAttachment,
  type DraftMailboxMeta,
  type DraftPayload,
  type ImapSyncMode,
} from "@/lib/mail/gmail-imap-source";
