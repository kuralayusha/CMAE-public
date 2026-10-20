import { sql } from "drizzle-orm";
import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey().default(1),
  fullName: text("full_name"),
  gmailAddress: text("gmail_address"),
  gmailAppPasswordEnc: text("gmail_app_password_enc"),
  cursorApiKeyEnc: text("cursor_api_key_enc"),
  cvText: text("cv_text"),
  cvFileName: text("cv_file_name"),
  followUpDays: integer("follow_up_days").notNull().default(5),
  preferredLanguage: text("preferred_language").notNull().default("en"),
  /** Plain-text email signature; newlines preserved. Appended verbatim after mail closing. */
  emailSignature: text("email_signature"),
  /** JSON: work types, notice weeks, salary expectations — see lib/settings/preferences.ts */
  jobPreferencesJson: text("job_preferences_json"),
  /** ISO timestamp when forced onboarding wizard finished; null = locked */
  onboardingCompletedAt: text("onboarding_completed_at"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const mailMessages = sqliteTable(
  "mail_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    messageId: text("message_id").notNull(),
    threadId: text("thread_id"),
    gmailUid: integer("gmail_uid"),
    folder: text("folder").notNull(), // INBOX | SENT
    fromAddr: text("from_addr").notNull(),
    toAddr: text("to_addr").notNull().default(""),
    ccAddr: text("cc_addr").notNull().default(""),
    subject: text("subject").notNull().default(""),
    dateIso: text("date_iso").notNull(),
    snippet: text("snippet").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    headersHash: text("headers_hash"),
    /** pending = needs tracker derivation; done = already applied */
    deriveState: text("derive_state").notNull().default("done"),
    /** Active Gmail account (lowercase). K2 fence. */
    accountId: text("account_id"),
    /** X-GM-MSGID / emailId */
    gmMsgid: text("gm_msgid"),
    /** JSON string[] of Gmail labels */
    labelsJson: text("labels_json"),
    /** in | out | self — from address vs account */
    direction: text("direction"),
    /** Server internal date (canonical sort) */
    internalDate: text("internal_date"),
    headerDate: text("header_date"),
    inReplyTo: text("in_reply_to"),
    referencesHdr: text("references_hdr"),
    /** JSON auto flags (autoSubmitted, bulk, listId, bounce) */
    autoFlags: text("auto_flags"),
    /** Set when missing from All Mail / window UID set (K1: fact stays) */
    goneAt: text("gone_at"),
    goneReason: text("gone_reason"),
    /** ok | truncated | failed */
    bodyState: text("body_state").notNull().default("ok"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [uniqueIndex("mail_messages_message_id_uq").on(t.messageId)],
);

/** Per-account mailbox cursor (All Mail / inbox / sent / drafts). */
export const mailSources = sqliteTable(
  "mail_sources",
  {
    accountId: text("account_id").notNull(),
    role: text("role").notNull(), // all | inbox | sent | drafts
    mailboxPath: text("mailbox_path").notNull(),
    uidValidity: text("uid_validity").notNull(),
    lastUid: integer("last_uid").notNull().default(0),
    highestModseq: text("highest_modseq"),
    lastMetaScanAt: text("last_meta_scan_at"),
    lastSuccessAt: text("last_success_at"),
    lastErrorKind: text("last_error_kind"),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.role] })],
);

export const mailFetchFailures = sqliteTable(
  "mail_fetch_failures",
  {
    accountId: text("account_id").notNull(),
    role: text("role").notNull(),
    uid: integer("uid").notNull(),
    attempts: integer("attempts").notNull().default(1),
    lastError: text("last_error"),
    firstAt: text("first_at").notNull(),
    lastAt: text("last_at").notNull(),
    abandoned: integer("abandoned").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.role, t.uid] })],
);
export const trackerItems = sqliteTable("tracker_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  company: text("company").notNull(),
  position: text("position"),
  /** Cached status for legacy readers; list uses effective() on read. */
  status: text("status").notNull().default("ready_to_send"),
  sentiment: text("sentiment"), // positive | negative | neutral
  waitingOn: text("waiting_on"), // us | them | null
  followUpCount: integer("follow_up_count").notNull().default(0),
  lastOutboundAt: text("last_outbound_at"),
  lastInboundAt: text("last_inbound_at"),
  nextFollowUpAt: text("next_follow_up_at"),
  ignored: integer("ignored").notNull().default(0),
  workspaceFolder: text("workspace_folder"),
  researchJobId: text("research_job_id"),
  primaryTo: text("primary_to"),
  notesJson: text("notes_json"),
  hasFollowUpDraft: integer("has_follow_up_draft").notNull().default(0),
  hasThanksDraft: integer("has_thanks_draft").notNull().default(0),
  hasReplyDraft: integer("has_reply_draft").notNull().default(0),
  /** active | inactive | dismissed — user overlay; derivation never writes */
  userState: text("user_state").notNull().default("active"),
  selectedRecipient: text("selected_recipient"),
  userVersion: integer("user_version").notNull().default(1),
  aiStatus: text("ai_status"),
  lastMeaningfulInboundAt: text("last_meaningful_inbound_at"),
  waitingUntil: text("waiting_until"),
  lastIntent: text("last_intent"),
  flagsJson: text("flags_json"),
  needsClassification: integer("needs_classification").notNull().default(0),
  derivedVersion: integer("derived_version").notNull().default(1),
  derivedAt: text("derived_at"),
  originResearchJobId: text("origin_research_job_id"),
  deletedAt: text("deleted_at"),
  deletedReason: text("deleted_reason"),
  mergedIntoId: integer("merged_into_id"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

/** Legacy junction — dual-written with mail_assignments in Faz 4. */
export const trackerItemMails = sqliteTable(
  "tracker_item_mails",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: integer("item_id")
      .notNull()
      .references(() => trackerItems.id, { onDelete: "cascade" }),
    mailId: integer("mail_id")
      .notNull()
      .references(() => mailMessages.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("inbound"), // outbound | inbound | followup | thanks
  },
  (t) => [uniqueIndex("tracker_item_mails_uq").on(t.itemId, t.mailId)],
);

/** One mail → at most one item (replaces multi-link tracker_item_mails). */
export const mailAssignments = sqliteTable("mail_assignments", {
  mailId: integer("mail_id")
    .primaryKey()
    .references(() => mailMessages.id, { onDelete: "cascade" }),
  itemId: integer("item_id")
    .notNull()
    .references(() => trackerItems.id),
  source: text("source").notNull(),
  confidence: real("confidence"),
  locked: integer("locked").notNull().default(0),
  assignedRev: integer("assigned_rev").notNull().default(0),
});

export const mailUnassigned = sqliteTable("mail_unassigned", {
  mailId: integer("mail_id")
    .primaryKey()
    .references(() => mailMessages.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  since: text("since").notNull(),
  attempts: integer("attempts").notNull().default(0),
});

export const mailIntents = sqliteTable("mail_intents", {
  mailId: integer("mail_id")
    .primaryKey()
    .references(() => mailMessages.id, { onDelete: "cascade" }),
  intent: text("intent").notNull(),
  waitingUntil: text("waiting_until"),
  confidence: real("confidence"),
  source: text("source").notNull(),
  model: text("model").notNull(),
  promptVersion: integer("prompt_version").notNull(),
  createdAt: text("created_at").notNull(),
});

export const mergeProposals = sqliteTable("merge_proposals", {
  id: text("id").primaryKey(),
  winnerId: integer("winner_id")
    .notNull()
    .references(() => trackerItems.id),
  loserId: integer("loser_id")
    .notNull()
    .references(() => trackerItems.id),
  origin: text("origin").notNull(),
  conflictsJson: text("conflicts_json").notNull(),
  state: text("state").notNull(),
  createdRev: integer("created_rev").notNull(),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
});

export const itemLineage = sqliteTable("item_lineage", {
  oldId: integer("old_id").notNull(),
  newId: integer("new_id").notNull(),
  kind: text("kind").notNull(),
  at: text("at").notNull(),
});

/** Row-level long-op locks (prepare / draft). Faz 6. */
export const itemOps = sqliteTable(
  "item_ops",
  {
    itemId: integer("item_id").notNull(),
    op: text("op").notNull(),
    owner: text("owner").notNull(),
    startedAt: text("started_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.op] })],
);

export const syncState = sqliteTable("sync_state", {
  id: integer("id").primaryKey().default(1),
  lastSyncAt: text("last_sync_at"),
  lastError: text("last_error"),
  windowDays: integer("window_days").notNull().default(30),
});

/** Per-folder IMAP cursor for incremental sync. Never delete mail_messages on sync. */
export const mailFolderCursors = sqliteTable("mail_folder_cursors", {
  folder: text("folder").primaryKey(), // INBOX | SENT
  mailboxPath: text("mailbox_path").notNull(),
  uidValidity: text("uid_validity").notNull(),
  lastUid: integer("last_uid").notNull().default(0),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

/**
 * Cached AI timeline for a mail set. Keyed by fingerprint of sorted messageIds
 * so it survives tracker_items wipe+rebuild on sync (item ids are not stable).
 */
export const trackerTimelines = sqliteTable(
  "tracker_timelines",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fingerprint: text("fingerprint").notNull(),
    company: text("company").notNull().default(""),
    position: text("position"),
    eventsJson: text("events_json").notNull().default("[]"),
    origin: text("origin").notNull().default("unknown"), // unknown | app | mixed
    model: text("model").notNull().default("composer-2.5"),
    locale: text("locale").notNull().default("en"),
    mailCount: integer("mail_count").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [uniqueIndex("tracker_timelines_fp_uq").on(t.fingerprint)],
);

/** Key/value app metadata (tracker_revision, db_epoch, …). */
export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** Changelog for SSE backfill (rev = tracker_revision after bump). */
export const trackerChanges = sqliteTable("tracker_changes", {
  rev: integer("rev").primaryKey(),
  at: text("at").notNull(),
  source: text("source").notNull(),
  kind: text("kind").notNull(),
  itemIds: text("item_ids").notNull().default("[]"),
});

export const schemaMigrations = sqliteTable("schema_migrations", {
  version: integer("version").primaryKey(),
  appliedAt: text("applied_at").notNull(),
});

/** Persistent sync / reconcile jobs with DB-level lease (partial unique on running). */
export const syncJobs = sqliteTable("sync_jobs", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  mode: text("mode").notNull().default("incremental"),
  state: text("state").notNull(),
  phase: text("phase"),
  reasons: text("reasons").notNull().default("[]"),
  rerunRequested: integer("rerun_requested").notNull().default(0),
  rerunMode: text("rerun_mode"),
  attempt: integer("attempt").notNull().default(1),
  owner: text("owner"),
  dbEpoch: integer("db_epoch").notNull(),
  credentialsVersion: integer("credentials_version").notNull(),
  accountId: text("account_id").notNull(),
  errorKind: text("error_kind"),
  errorMessage: text("error_message"),
  statsJson: text("stats_json"),
  queuedAt: text("queued_at").notNull(),
  startedAt: text("started_at"),
  heartbeatAt: text("heartbeat_at"),
  progressAt: text("progress_at"),
  finishedAt: text("finished_at"),
  nextRetryAt: text("next_retry_at"),
});

/** Gmail Drafts lifecycle — source of truth for pending send UX (Faz 5). */
export const gmailDrafts = sqliteTable("gmail_drafts", {
  id: text("id").primaryKey(),
  itemId: integer("item_id")
    .notNull()
    .references(() => trackerItems.id),
  accountId: text("account_id").notNull(),
  kind: text("kind").notNull(),
  /** creating|present|sent|deleted_by_user|failed|unknown|superseded */
  state: text("state").notNull(),
  messageIdHdr: text("message_id_hdr").notNull(),
  gmMsgid: text("gm_msgid"),
  gmThrid: text("gm_thrid"),
  draftsUid: integer("drafts_uid"),
  draftsUidvalidity: text("drafts_uidvalidity"),
  subject: text("subject").notNull(),
  toAddr: text("to_addr").notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: text("created_at").notNull(),
  confirmedAt: text("confirmed_at"),
  lastSeenAt: text("last_seen_at"),
  lastCheckedAt: text("last_checked_at"),
  missingSince: text("missing_since"),
  missingChecks: integer("missing_checks").notNull().default(0),
  sentMailId: integer("sent_mail_id").references(() => mailMessages.id),
  error: text("error"),
});

/** Disk-derived research/draft file index (Faz 7). Source of truth for GET draft flags + recipients. */
export const workspaceFiles = sqliteTable(
  "workspace_files",
  {
    folder: text("folder").notNull(),
    name: text("name").notNull(),
    /** email | follow_up_n | thanks | reply | contact | summary | other */
    kind: text("kind"),
    mtimeMs: integer("mtime_ms"),
    size: integer("size"),
    subject: text("subject"),
    /** Same algorithm as gmail_drafts.content_hash when To is known. */
    contentHash: text("content_hash"),
    /** contact.md: { recommended, candidates } */
    metaJson: text("meta_json"),
  },
  (t) => [primaryKey({ columns: [t.folder, t.name] })],
);

export const workspaceFolders = sqliteTable("workspace_folders", {
  folder: text("folder").primaryKey(),
  present: integer("present").notNull(),
  scannedAt: text("scanned_at"),
});
