import { t } from "@/lib/i18n/t";
import { getTrackerRevision } from "@/lib/db/revision";
import {
  loadRecipientsForItem,
  withSelectedRecipient,
} from "./recipients";
import { withItemTx } from "./item-tx";

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export function setTrackerItemRecipient(
  itemId: number,
  emailRaw: string,
  opts?: { expectUserVersion?: number },
): {
  id: number;
  primaryTo: string;
  recommendedTo: string | null;
  recipientOptions: ReturnType<typeof loadRecipientsForItem>["candidates"];
  userVersion: number;
  rev: number;
} {
  const email = emailRaw.trim();
  if (!EMAIL_RE.test(email)) {
    throw new Error(t("tracker.error.invalidRecipient"));
  }

  const txResult = withItemTx(
    itemId,
    { expectUserVersion: opts?.expectUserVersion, source: "mutation" },
    (_sqlite, item) => {
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

      return {
        patch: {
          primaryTo: canonical,
          selectedRecipient: canonical,
          notesJson: withSelectedRecipient(item.notesJson, canonical),
        },
        result: {
          canonical,
          recipients,
        },
      };
    },
  );

  return {
    id: itemId,
    primaryTo: txResult.result.canonical,
    recommendedTo: txResult.result.recipients.recommended,
    recipientOptions: txResult.result.recipients.candidates,
    userVersion: txResult.userVersion,
    rev: txResult.rev || getTrackerRevision(),
  };
}
