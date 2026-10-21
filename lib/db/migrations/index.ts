import { migration001Baseline } from "./001_baseline";
import { migration002Revision } from "./002_revision";
import { migration003SyncJobs } from "./003_sync_jobs";
import { migration004MailSources } from "./004_mail_sources";
import { migration005Derive } from "./005_derive";
import { migration006GmailDrafts } from "./006_gmail_drafts";
import { migration007ItemOps } from "./007_item_ops";
import { migration008WorkspaceIndex } from "./008_workspace_index";
import { migration009CleanupLegacy } from "./009_cleanup_legacy";
import { migration010Conversations } from "./010_conversations";
import { migration011ConversationAi } from "./011_conversation_ai";
import { migration012AiUsage } from "./012_ai_usage";
import { migration013MailEventScheduled } from "./013_mail_event_scheduled";
import { migration014AiUsageRunId } from "./014_ai_usage_run_id";
import type { Migration } from "./types";

export const MIGRATIONS: Migration[] = [
  migration001Baseline,
  migration002Revision,
  migration003SyncJobs,
  migration004MailSources,
  migration005Derive,
  migration006GmailDrafts,
  migration007ItemOps,
  migration008WorkspaceIndex,
  migration009CleanupLegacy,
  migration010Conversations,
  migration011ConversationAi,
  migration012AiUsage,
  migration013MailEventScheduled,
  migration014AiUsageRunId,
];
