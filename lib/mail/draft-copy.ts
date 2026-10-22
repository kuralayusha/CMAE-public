/**
 * Gmail "All Mail" also lists the user's unsent drafts (label `\Draft`).
 * Those are NOT real mails: sender is the user, so they would look like an
 * outbound application and flip the tracker row to "sent" before anything left.
 * Once actually sent, the message carries `\Sent` and loses `\Draft`.
 */
export function isDraftCopyLabels(
  labels: readonly string[] | string | null | undefined,
): boolean {
  let list: string[] = [];
  if (Array.isArray(labels)) list = labels.map(String);
  else if (typeof labels === "string" && labels) {
    try {
      const parsed = JSON.parse(labels);
      if (Array.isArray(parsed)) list = parsed.map(String);
    } catch {
      return false;
    }
  }
  const low = list.map((l) => l.replace(/^\\+/, "").toLowerCase());
  return low.includes("draft") && !low.includes("sent");
}
