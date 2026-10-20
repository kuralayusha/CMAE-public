/**
 * Header / regex noise detection before assignment.
 */

import { isNonJobMail } from "../signals";

export type AutoFlags = {
  autoSubmitted?: string | null;
  bulk?: boolean;
  listId?: string | null;
  bounce?: boolean;
};

export function parseAutoFlags(raw: string | null | undefined): AutoFlags | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AutoFlags;
  } catch {
    return null;
  }
}

/** Deterministic noise: List-Id, Precedence bulk, noreply-ish auto-submitted without bounce. */
export function isNoiseMail(input: {
  subject: string;
  fromAddr: string;
  toAddr: string;
  snippet: string;
  bodyPreview?: string;
  autoFlags?: AutoFlags | null;
}): boolean {
  const flags = input.autoFlags;
  if (flags?.listId) return true;
  if (flags?.bulk) return true;
  // Bounce is not noise — it is a fact (assign/classify as bounce).
  if (flags?.bounce) return false;
  const auto = (flags?.autoSubmitted || "").toLowerCase();
  if (auto && auto !== "no" && !auto.includes("auto-replied")) {
    // auto-generated / auto-notified without OOO semantics → noise
    if (auto.includes("auto-generated") || auto.includes("auto-notified")) {
      return true;
    }
  }
  return isNonJobMail({
    subject: input.subject,
    fromAddr: input.fromAddr,
    toAddr: input.toAddr,
    bodyPreview: input.bodyPreview || input.snippet,
    snippet: input.snippet,
  });
}
