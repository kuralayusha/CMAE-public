export const TRACKER_STATUSES = [
  "ready_to_send",
  "needs_reply",
  "needs_action",
  "follow_up_due",
  "waiting",
  "in_progress",
  "rejected",
  "closed",
  "inactive",
  "ignored",
] as const;

export type TrackerStatus = (typeof TRACKER_STATUSES)[number];

export type TrackerSentiment = "positive" | "negative" | "neutral";

export type WaitingOn = "us" | "them";

export type MailFolder = "INBOX" | "SENT";

export type MailRole = "outbound" | "inbound" | "followup" | "thanks";

export type DraftKind = "application" | "follow_up" | "thanks" | "reply";

export type FetchedMail = {
  messageId: string;
  threadId: string | null;
  gmailUid: number | null;
  folder: MailFolder;
  fromAddr: string;
  toAddr: string;
  ccAddr: string;
  subject: string;
  dateIso: string;
  snippet: string;
  bodyText: string;
  headersHash: string | null;
};

/** Sync terminal log kinds — mirrors search TermKind subset */
export type SyncLogKind = "think" | "system" | "ok" | "err" | "curl";

export type SyncLogLine = {
  id: string;
  kind: SyncLogKind;
  text: string;
  at: number;
};

export type SyncProgressFn = (kind: SyncLogKind, text: string) => void;

export type TrackerItemRow = {
  id: number;
  company: string;
  position: string | null;
  status: TrackerStatus;
  sentiment: TrackerSentiment | null;
  waitingOn: WaitingOn | null;
  followUpCount: number;
  lastOutboundAt: string | null;
  lastInboundAt: string | null;
  nextFollowUpAt: string | null;
  ignored: boolean;
  workspaceFolder: string | null;
  researchJobId: string | null;
  primaryTo: string | null;
  notesJson: string | null;
  hasFollowUpDraft: boolean;
  hasThanksDraft: boolean;
  hasReplyDraft: boolean;
  updatedAt: string;
  createdAt: string;
};

export type PendingGmailDraftInfo = {
  kind: DraftKind;
  at: string;
  subject: string;
  draftsUrl?: string;
  /** creating|present|unknown|deleted_by_user|sent|… — from gmail_drafts */
  state?: string;
  confirmedAt?: string | null;
};

export type RecipientCandidateInfo = {
  email: string;
  role: string | null;
  priority: number | null;
  reason: string | null;
  recommended: boolean;
};

export type TrackerListItem = TrackerItemRow & {
  lastActivityAt: string | null;
  statusLabel: string;
  /** Unique Gmail thread URLs for linked mails (open each in its own tab) */
  gmailUrls: string[];
  /** OOO / dated wait — when they said they'd be back (YYYY-MM-DD) */
  waitingUntil: string | null;
  /**
   * Gmail Drafts created in CMAE but not yet seen as SENT.
   * Status stays put until sync finds the outbound.
   */
  pendingGmailDraft: PendingGmailDraftInfo | null;
  /**
   * Contact.md candidates (research). Length > 1 → UI shows recipient select.
   * Empty for mail-only rows without a company folder contact list.
   */
  recipientOptions: RecipientCandidateInfo[];
  /** AI recommended address from contact.md (may differ from primaryTo). */
  recommendedTo: string | null;
  /** Optimistic concurrency token for user-column mutations. */
  userVersion: number;
  /**
   * Disk/index warnings for the row (i18n keys under tracker.warning.*).
   * e.g. folderMissing, draftContentMismatch
   */
  warnings?: TrackerRowWarning[];
  /** Some timeline events come from the rule fallback, not AI (shown as a badge). */
  unverified?: boolean;
  /** ATS / agency / job board the process runs through (stage 2). */
  channel?: string | null;
};

export type TrackerRowWarning =
  | { code: "folderMissing"; message: string }
  | { code: "draftContentMismatch"; message: string };

export type TrackerSection = {
  status: TrackerStatus;
  title: string;
  items: TrackerListItem[];
};

export const STATUS_ORDER: TrackerStatus[] = [...TRACKER_STATUSES];

export const STATUS_TITLES: Record<TrackerStatus, string> = {
  ready_to_send: "Ready to send",
  needs_reply: "Reply needed",
  needs_action: "Action needed (link / form)",
  follow_up_due: "Follow-up due",
  waiting: "Waiting (dated)",
  in_progress: "Active conversations",
  rejected: "Rejected",
  closed: "Closed",
  inactive: "Inactive",
  ignored: "Ignored",
};
