import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bumpTrackerRevision } from "@/lib/db/revision";
import { trackerItems } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
import {
  loadRecipientsForItem,
  withSelectedRecipient,
} from "./recipients";

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export function setTrackerItemRecipient(
  itemId: number,
  emailRaw: string,
): {
  id: number;
  primaryTo: string;
  recommendedTo: string | null;
  recipientOptions: ReturnType<typeof loadRecipientsForItem>["candidates"];
} {
  const email = emailRaw.trim();
  if (!EMAIL_RE.test(email)) {
    throw new Error(t("tracker.error.invalidRecipient"));
  }

  const db = getDb();
  const item = db
    .select()
    .from(trackerItems)
    .where(eq(trackerItems.id, itemId))
    .get();
  if (!item) throw new Error(t("tracker.error.notFound"));

  const recipients = loadRecipientsForItem(item);
  if (recipients.candidates.length > 1) {
    const hit = recipients.candidates.find(
      (c) => c.email.toLowerCase() === email.toLowerCase(),
    );
    if (!hit) {
      throw new Error(t("tracker.error.recipientNotInCandidates"));
    }
  }

  const canonical =
    recipients.candidates.find(
      (c) => c.email.toLowerCase() === email.toLowerCase(),
    )?.email || email;

  db.update(trackerItems)
    .set({
      primaryTo: canonical,
      selectedRecipient: canonical,
      userVersion: (item.userVersion || 1) + 1,
      notesJson: withSelectedRecipient(item.notesJson, canonical),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(trackerItems.id, itemId))
    .run();
  bumpTrackerRevision("mutation", "upsert", [itemId]);

  return {
    id: itemId,
    primaryTo: canonical,
    recommendedTo: recipients.recommended,
    recipientOptions: recipients.candidates,
  };
}
