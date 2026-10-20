/** After a follow-up is sent, block the next one for this many days. */
export const FOLLOW_UP_REPEAT_COOLDOWN_DAYS = 7;

/**
 * After a rejection, we are expected to send thanks/feedback.
 * If we stay silent this many days, auto-close the thread.
 */
export const REJECTION_AUTO_CLOSE_DAYS = 7;

/** First follow-up uses settings days; each later one waits a fixed 7-day cooldown. */
export function followUpSilenceDays(
  followUpCount: number,
  followUpDays: number,
): number {
  if (followUpCount >= 1) return FOLLOW_UP_REPEAT_COOLDOWN_DAYS;
  return Math.max(1, followUpDays);
}
