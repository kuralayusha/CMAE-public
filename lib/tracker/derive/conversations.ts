/**
 * Stage 0 — deterministic conversation assembly (architecture §2.6.5).
 *
 * Gmail thread id first, then In-Reply-To / References message-id links.
 * Assignment is conversation-scoped: once any mail of a conversation belongs
 * to an item, every other unassigned mail of it (SENT included) follows in the
 * same transaction. That also re-tries `mail_unassigned(unmatched_outbound)`.
 */

import { eq } from "drizzle-orm";
import { getDb, getSqlite } from "@/lib/db/client";
import { mailAssignments, mailMessages } from "@/lib/db/schema";
import { writeAssignment } from "./assign";
import {
  assembleConversations,
  conversationItem,
  planConversationAssignments,
  type Conversation,
  type ConversationMail,
} from "./conversation-graph";

export * from "./conversation-graph";

function loadConversationMails(): ConversationMail[] {
  return getDb()
    .select({
      id: mailMessages.id,
      threadId: mailMessages.threadId,
      messageId: mailMessages.messageId,
      inReplyTo: mailMessages.inReplyTo,
      referencesHdr: mailMessages.referencesHdr,
      internalDate: mailMessages.internalDate,
      dateIso: mailMessages.dateIso,
      accountId: mailMessages.accountId,
    })
    .from(mailMessages)
    .all()
    .map((m) => ({
      id: m.id,
      threadId: m.threadId,
      messageId: m.messageId,
      inReplyTo: m.inReplyTo,
      referencesHdr: m.referencesHdr,
      at: m.internalDate || m.dateIso,
      accountId: m.accountId,
    }));
}

function loadAssignedMap(): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of getDb().select().from(mailAssignments).all()) {
    map.set(row.mailId, row.itemId);
  }
  return map;
}

/**
 * Rebuild `mail_conversations` from mail_messages. Rows whose fingerprint
 * did not change are left untouched (stage 1/3 caches key off it).
 */
export function syncConversations(): Conversation[] {
  const convs = assembleConversations(loadConversationMails());
  const assigned = loadAssignedMap();
  const sqlite = getSqlite();
  const existing = new Map(
    (
      sqlite
        .prepare(`SELECT id, fingerprint, item_id AS itemId FROM mail_conversations`)
        .all() as { id: string; fingerprint: string; itemId: number | null }[]
    ).map((r) => [r.id, r]),
  );
  const now = new Date().toISOString();
  const upsert = sqlite.prepare(
    `INSERT INTO mail_conversations
       (id, account_id, thread_key, mail_ids, fingerprint, item_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       account_id = excluded.account_id,
       thread_key = excluded.thread_key,
       mail_ids = excluded.mail_ids,
       fingerprint = excluded.fingerprint,
       item_id = excluded.item_id,
       updated_at = excluded.updated_at`,
  );
  const del = sqlite.prepare(`DELETE FROM mail_conversations WHERE id = ?`);
  sqlite.transaction(() => {
    const seen = new Set<string>();
    for (const conv of convs) {
      seen.add(conv.key);
      const itemId = conversationItem(conv, assigned);
      const prev = existing.get(conv.key);
      if (
        prev &&
        prev.fingerprint === conv.fingerprint &&
        (prev.itemId ?? null) === itemId
      ) {
        continue;
      }
      upsert.run(
        conv.key,
        conv.accountId,
        conv.threadKey,
        JSON.stringify(conv.mailIds),
        conv.fingerprint,
        itemId,
        now,
      );
    }
    for (const id of existing.keys()) {
      if (!seen.has(id)) del.run(id);
    }
  })();
  return convs;
}

/**
 * Attach every unassigned mail of an assigned conversation to that item.
 * Returns touched item ids (caller refreshes facts).
 */
export function attachConversationMails(): Set<number> {
  const convs = syncConversations();
  const assigned = loadAssignedMap();
  const plan = planConversationAssignments(convs, assigned);
  const touched = new Set<number>();
  if (!plan.size) return touched;

  const byConv = new Map<string, { mailId: number; itemId: number }[]>();
  for (const [mailId, p] of plan) {
    const list = byConv.get(p.conversationKey) || [];
    list.push({ mailId, itemId: p.itemId });
    byConv.set(p.conversationKey, list);
  }

  const sqlite = getSqlite();
  const db = getDb();
  for (const [convKey, rows] of byConv) {
    sqlite.transaction(() => {
      for (const row of rows) {
        const mail = db
          .select({
            folder: mailMessages.folder,
            subject: mailMessages.subject,
            bodyText: mailMessages.bodyText,
          })
          .from(mailMessages)
          .where(eq(mailMessages.id, row.mailId))
          .get();
        if (!mail) continue;
        writeAssignment({
          mailId: row.mailId,
          itemId: row.itemId,
          source: "thread",
          confidence: 0.9,
          mail,
        });
        touched.add(row.itemId);
      }
      sqlite
        .prepare(`UPDATE mail_conversations SET item_id = ? WHERE id = ?`)
        .run(rows[0]!.itemId, convKey);
    })();
  }
  return touched;
}
