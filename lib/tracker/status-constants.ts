/** After a follow-up is sent, block the next one for this many days. */
export const FOLLOW_UP_REPEAT_COOLDOWN_DAYS = 7;

/**
 * Default for settings.rejection_close_days: after a rejection we are expected
 * to send thanks; if we stay silent this many days, the row closes.
 */
export const DEFAULT_REJECTION_CLOSE_DAYS = 10;

/**
 * Default for settings.stale_close_days: no human reply this many days after
 * the user's last outbound mail (application or follow-up) → closed.
 */
export const DEFAULT_STALE_CLOSE_DAYS = 20;

/** @deprecated use settings.rejectionCloseDays (DEFAULT_REJECTION_CLOSE_DAYS). */
export const REJECTION_AUTO_CLOSE_DAYS = DEFAULT_REJECTION_CLOSE_DAYS;

/** First follow-up uses settings days; each later one waits a fixed 7-day cooldown. */
export function followUpSilenceDays(
  followUpCount: number,
  followUpDays: number,
): number {
  if (followUpCount >= 1) return FOLLOW_UP_REPEAT_COOLDOWN_DAYS;
  return Math.max(1, followUpDays);
}

export type StatusSettings = {
  followUpDays: number;
  rejectionCloseDays: number;
  staleCloseDays: number;
};

export function statusSettingsFromRow(
  row:
    | {
        followUpDays?: number | null;
        rejectionCloseDays?: number | null;
        staleCloseDays?: number | null;
      }
    | null
    | undefined,
): StatusSettings {
  return {
    followUpDays: row?.followUpDays || 5,
    rejectionCloseDays: row?.rejectionCloseDays || DEFAULT_REJECTION_CLOSE_DAYS,
    staleCloseDays: row?.staleCloseDays || DEFAULT_STALE_CLOSE_DAYS,
  };
}
