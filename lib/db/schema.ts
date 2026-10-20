import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [uniqueIndex("mail_messages_message_id_uq").on(t.messageId)],
);

export const trackerItems = sqliteTable("tracker_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  company: text("company").notNull(),
  position: text("position"),
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
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

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
