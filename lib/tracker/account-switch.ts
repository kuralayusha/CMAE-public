/**
 * K2: different Gmail account → confirm → fenced wipe of old account data.
 */

import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import {
  bumpAppMetaInt,
  getAppMeta,
  normalizeAccountId,
  setAppMeta,
} from "@/lib/db/app-meta";
import { getSqlite } from "@/lib/db/client";
import { getDataDir } from "@/lib/paths";
import { bumpRevision } from "@/lib/db/revision";
import { notifyCredentialsChanged } from "@/lib/sync/credentials";
import {
  clearMaintenance,
  prepareResetFencing,
} from "@/lib/sync/engine";
import { emitTrackerEvent } from "./events-bus";

export type AccountSwitchPreview = {
  required: boolean;
  oldAccountId: string;
  newAccountId: string;
  mailCount: number;
  itemCount: number;
  draftCount: number;
  researchOnlyKept: number;
};

function countSql(
  db: Database.Database,
  sql: string,
  ...params: unknown[]
): number {
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function previewAccountSwitch(
  newGmailAddress: string,
): AccountSwitchPreview {
  const db = getSqlite();
  const oldAccountId = getAppMeta("account_id", db) || "";
  const newAccountId = normalizeAccountId(newGmailAddress);
  if (!newAccountId || !oldAccountId || newAccountId === oldAccountId) {
    return {
      required: false,
      oldAccountId,
      newAccountId,
      mailCount: 0,
      itemCount: 0,
      draftCount: 0,
      researchOnlyKept: 0,
    };
  }

  const mailCount = countSql(
    db,
    `SELECT COUNT(*) AS n FROM mail_messages WHERE account_id = ?`,
    oldAccountId,
  );
  const draftCount = countSql(
    db,
    `SELECT COUNT(*) AS n FROM gmail_drafts WHERE account_id = ?`,
    oldAccountId,
  );

  // Items whose assigned mails are entirely from old account (or have no mails
  // but are not research-only ready_to_send).
  const itemCount = countSql(
    db,
    `SELECT COUNT(*) AS n FROM tracker_items ti
     WHERE ti.deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM mail_assignments ma
         JOIN mail_messages mm ON mm.id = ma.mail_id
         WHERE ma.item_id = ti.id AND mm.account_id = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM mail_assignments ma2
         JOIN mail_messages mm2 ON mm2.id = ma2.mail_id
         WHERE ma2.item_id = ti.id
           AND (mm2.account_id IS NULL OR mm2.account_id != ?)
       )`,
    oldAccountId,
    oldAccountId,
  );

  const researchOnlyKept = countSql(
    db,
    `SELECT COUNT(*) AS n FROM tracker_items ti
     WHERE ti.deleted_at IS NULL
       AND (ti.status = 'ready_to_send' OR ti.ai_status = 'ready_to_send')
       AND NOT EXISTS (
         SELECT 1 FROM mail_assignments ma WHERE ma.item_id = ti.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM tracker_item_mails tim WHERE tim.item_id = ti.id
       )`,
  );

  return {
    required: true,
    oldAccountId,
    newAccountId,
    mailCount,
    itemCount,
    draftCount,
    researchOnlyKept,
  };
}

async function backupBeforeSwitch(
  db: Database.Database,
): Promise<string | null> {
  try {
    const dataDir = getDataDir();
    const dest = path.join(dataDir, "cmae.db.pre-account-switch");
    if (fs.existsSync(dest)) {
      try {
        fs.unlinkSync(dest);
      } catch {
        /* ignore */
      }
    }
    // better-sqlite3 13+: backup returns a Promise
    await db.backup(dest);
    setAppMeta("schema_backup_path", dest, db);
    return dest;
  } catch (err) {
    console.error("[account-switch] backup failed", err);
    return null;
  }
}

function deleteOldAccountData(db: Database.Database, oldAccountId: string) {
  // Collect item ids fully owned by old account
  const itemIds = (
    db
      .prepare(
        `SELECT ti.id AS id FROM tracker_items ti
         WHERE ti.deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM mail_assignments ma
             JOIN mail_messages mm ON mm.id = ma.mail_id
             WHERE ma.item_id = ti.id AND mm.account_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM mail_assignments ma2
             JOIN mail_messages mm2 ON mm2.id = ma2.mail_id
             WHERE ma2.item_id = ti.id
               AND (mm2.account_id IS NULL OR mm2.account_id != ?)
           )`,
      )
      .all(oldAccountId, oldAccountId) as { id: number }[]
  ).map((r) => r.id);

  // Also items linked only via legacy tracker_item_mails to old-account mails
  const legacyIds = (
    db
      .prepare(
        `SELECT ti.id AS id FROM tracker_items ti
         WHERE ti.deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM tracker_item_mails tim
             JOIN mail_messages mm ON mm.id = tim.mail_id
             WHERE tim.item_id = ti.id AND mm.account_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM tracker_item_mails tim2
             JOIN mail_messages mm2 ON mm2.id = tim2.mail_id
             WHERE tim2.item_id = ti.id
               AND (mm2.account_id IS NULL OR mm2.account_id != ?)
           )
           AND NOT EXISTS (
             SELECT 1 FROM mail_assignments ma WHERE ma.item_id = ti.id
           )`,
      )
      .all(oldAccountId, oldAccountId) as { id: number }[]
  ).map((r) => r.id);

  const allItemIds = [...new Set([...itemIds, ...legacyIds])];

  if (allItemIds.length) {
    const placeholders = allItemIds.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM item_ops WHERE item_id IN (${placeholders})`,
    ).run(...allItemIds);
    db.prepare(
      `DELETE FROM merge_proposals
       WHERE winner_id IN (${placeholders}) OR loser_id IN (${placeholders})`,
    ).run(...allItemIds, ...allItemIds);
    db.prepare(
      `DELETE FROM item_lineage
       WHERE old_id IN (${placeholders}) OR new_id IN (${placeholders})`,
    ).run(...allItemIds, ...allItemIds);
    db.prepare(
      `DELETE FROM tracker_item_mails WHERE item_id IN (${placeholders})`,
    ).run(...allItemIds);
    db.prepare(
      `DELETE FROM mail_assignments WHERE item_id IN (${placeholders})`,
    ).run(...allItemIds);
    db.prepare(
      `DELETE FROM tracker_items WHERE id IN (${placeholders})`,
    ).run(...allItemIds);
  }

  // Timelines keyed by mail fingerprint — wipe all (safe after mail delete)
  db.prepare(`DELETE FROM tracker_timelines`).run();

  db.prepare(`DELETE FROM gmail_drafts WHERE account_id = ?`).run(oldAccountId);
  db.prepare(`DELETE FROM mail_fetch_failures WHERE account_id = ?`).run(
    oldAccountId,
  );
  db.prepare(`DELETE FROM mail_sources WHERE account_id = ?`).run(oldAccountId);

  // CASCADE from mail_messages → intents / assignments / unassigned
  db.prepare(`DELETE FROM mail_messages WHERE account_id = ?`).run(oldAccountId);

  // Orphan assignments pointing at deleted mails already cascaded; clear leftovers
  db.prepare(
    `DELETE FROM mail_assignments WHERE mail_id NOT IN (SELECT id FROM mail_messages)`,
  ).run();
  db.prepare(
    `DELETE FROM mail_unassigned WHERE mail_id NOT IN (SELECT id FROM mail_messages)`,
  ).run();
  db.prepare(
    `DELETE FROM mail_intents WHERE mail_id NOT IN (SELECT id FROM mail_messages)`,
  ).run();
}

/**
 * Complete any leftover rows whose account_id ≠ app_meta.account_id (crash recovery).
 */
export function completeOrphanAccountWipe(): void {
  try {
    const db = getSqlite();
    const active = getAppMeta("account_id", db) || "";
    if (!active) return;
    const orphans = countSql(
      db,
      `SELECT COUNT(*) AS n FROM mail_messages
       WHERE account_id IS NOT NULL AND account_id != '' AND account_id != ?`,
      active,
    );
    if (!orphans) return;
    const oldIds = (
      db
        .prepare(
          `SELECT DISTINCT account_id AS id FROM mail_messages
           WHERE account_id IS NOT NULL AND account_id != '' AND account_id != ?`,
        )
        .all(active) as { id: string }[]
    ).map((r) => r.id);
    db.transaction(() => {
      for (const old of oldIds) {
        console.warn(
          `[account-switch] completing orphan wipe for account hash=${old.length}`,
        );
        deleteOldAccountData(db, old);
      }
      bumpRevision(db, "account_switch", "global", "all");
    }).immediate();
  } catch (err) {
    console.error("[account-switch] orphan wipe failed", err);
  }
}

export type AccountSwitchResult = {
  ok: boolean;
  rev: number;
  preview: AccountSwitchPreview;
};

/**
 * After confirm: maintenance → cancel jobs → backup → wipe old account →
 * set new account_id + credentials_version + db_epoch → SSE reset.
 * Caller writes new settings credentials separately (or pass nextGmail).
 */
export async function executeAccountSwitch(
  newGmailAddress: string,
): Promise<AccountSwitchResult> {
  const preview = previewAccountSwitch(newGmailAddress);
  if (!preview.required) {
    return { ok: true, rev: 0, preview };
  }

  await prepareResetFencing();
  const db = getSqlite();
  let rev = 0;

  try {
    await backupBeforeSwitch(db);

    const run = db.transaction(() => {
      deleteOldAccountData(db, preview.oldAccountId);
      setAppMeta("account_id", preview.newAccountId, db);
      // db_epoch already bumped in prepareResetFencing; bump again so any
      // writer that raced after fencing still fails the check.
      bumpAppMetaInt("db_epoch", db);
      rev = bumpRevision(db, "account_switch", "global", "all");
    });
    run.immediate();
  } finally {
    clearMaintenance();
  }

  notifyCredentialsChanged();
  emitTrackerEvent({ type: "reset", rev });

  return { ok: true, rev, preview };
}

/** Prune pre-account-switch backups older than 7 days. */
export function pruneAccountSwitchBackups(): void {
  try {
    const dataDir = getDataDir();
    const dest = path.join(dataDir, "cmae.db.pre-account-switch");
    if (!fs.existsSync(dest)) return;
    const st = fs.statSync(dest);
    const age = Date.now() - st.mtimeMs;
    if (age > 7 * 24 * 60 * 60 * 1000) {
      fs.unlinkSync(dest);
    }
  } catch {
    /* ignore */
  }
}
