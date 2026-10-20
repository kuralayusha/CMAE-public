import { migration001Baseline } from "./001_baseline";
import { migration002Revision } from "./002_revision";
import { migration003SyncJobs } from "./003_sync_jobs";
import { migration004MailSources } from "./004_mail_sources";
import type { Migration } from "./types";

export const MIGRATIONS: Migration[] = [
  migration001Baseline,
  migration002Revision,
  migration003SyncJobs,
  migration004MailSources,
];
