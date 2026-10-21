export type ItemFlags = {
  autoReply: boolean;
  ackOnly: boolean;
  clickAction: boolean;
  rejected: boolean;
  thanksSent: boolean;
  bounced: boolean;
  /** Some event of the row is a fallback, not an AI-verified label (UI badge). */
  unverified: boolean;
};

export function factsToFlagsJson(flags: ItemFlags): string {
  return JSON.stringify(flags);
}

export function parseFlagsJson(raw: string | null | undefined): ItemFlags {
  const empty: ItemFlags = {
    autoReply: false,
    ackOnly: false,
    clickAction: false,
    rejected: false,
    thanksSent: false,
    bounced: false,
    unverified: false,
  };
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw) as Partial<ItemFlags>;
    return {
      autoReply: Boolean(v.autoReply),
      ackOnly: Boolean(v.ackOnly),
      clickAction: Boolean(v.clickAction),
      rejected: Boolean(v.rejected),
      thanksSent: Boolean(v.thanksSent),
      bounced: Boolean(v.bounced),
      unverified: Boolean(v.unverified),
    };
  } catch {
    return empty;
  }
}
