/**
 * Canonical mail↔item links via mail_assignments (Faz 8: tracker_item_mails gone).
 */

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mailAssignments } from "@/lib/db/schema";

export function listMailIdsForItem(itemId: number): number[] {
  return getDb()
    .select({ mailId: mailAssignments.mailId })
    .from(mailAssignments)
    .where(eq(mailAssignments.itemId, itemId))
    .all()
    .map((r) => r.mailId);
}

export function itemHasAssignedMails(itemId: number): boolean {
  const row = getDb()
    .select({ mailId: mailAssignments.mailId })
    .from(mailAssignments)
    .where(eq(mailAssignments.itemId, itemId))
    .get();
  return Boolean(row);
}
