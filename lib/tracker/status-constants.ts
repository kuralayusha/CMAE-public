/** After a follow-up is sent, block the next one for this many days. */
export const FOLLOW_UP_REPEAT_COOLDOWN_DAYS = 7;

/** Default for settings.follow_up_days (first follow-up silence window). */
export const DEFAULT_FOLLOW_UP_DAYS = 7;

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

/** Allowed ranges for settings day fields (settings UI + PUT /api/settings). */
export const FOLLOW_UP_DAYS_MIN = 1;
export const FOLLOW_UP_DAYS_MAX = 21;
export const REJECTION_CLOSE_DAYS_MIN = 1;
export const REJECTION_CLOSE_DAYS_MAX = 60;
/** Must exceed FOLLOW_UP_REPEAT_COOLDOWN_DAYS so a 2nd follow-up window can open. */
export const STALE_CLOSE_DAYS_MIN = FOLLOW_UP_REPEAT_COOLDOWN_DAYS + 1;
export const STALE_CLOSE_DAYS_MAX = 90;

export type StatusDayField = "followUpDays" | "rejectionCloseDays" | "staleCloseDays";

export type StatusDayValidationOk = {
  ok: true;
  followUpDays: number;
  rejectionCloseDays: number;
  staleCloseDays: number;
};

export type StatusDayValidationErr = {
  ok: false;
  code:
    | "followUpDaysRange"
    | "rejectionCloseDaysRange"
    | "staleCloseDaysRange"
    | "followUpBeforeStale";
  field?: StatusDayField;
};

/**
 * Parse + validate the three silence/close day settings together.
 * Cross-rule: followUpDays < staleCloseDays (otherwise follow_up_due never appears).
 */
export function validateStatusDaySettings(input: {
  followUpDays: number;
  rejectionCloseDays: number;
  staleCloseDays: number;
}): StatusDayValidationOk | StatusDayValidationErr {
  const followUpDays = Number(input.followUpDays);
  const rejectionCloseDays = Number(input.rejectionCloseDays);
  const staleCloseDays = Number(input.staleCloseDays);

  if (
    !Number.isInteger(followUpDays) ||
    followUpDays < FOLLOW_UP_DAYS_MIN ||
    followUpDays > FOLLOW_UP_DAYS_MAX
  ) {
    return { ok: false, code: "followUpDaysRange", field: "followUpDays" };
  }
  if (
    !Number.isInteger(rejectionCloseDays) ||
    rejectionCloseDays < REJECTION_CLOSE_DAYS_MIN ||
    rejectionCloseDays > REJECTION_CLOSE_DAYS_MAX
  ) {
    return {
      ok: false,
      code: "rejectionCloseDaysRange",
      field: "rejectionCloseDays",
    };
  }
  if (
    !Number.isInteger(staleCloseDays) ||
    staleCloseDays < STALE_CLOSE_DAYS_MIN ||
    staleCloseDays > STALE_CLOSE_DAYS_MAX
  ) {
    return { ok: false, code: "staleCloseDaysRange", field: "staleCloseDays" };
  }
  if (followUpDays >= staleCloseDays) {
    return { ok: false, code: "followUpBeforeStale", field: "followUpDays" };
  }
  return { ok: true, followUpDays, rejectionCloseDays, staleCloseDays };
}

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
    followUpDays: row?.followUpDays || DEFAULT_FOLLOW_UP_DAYS,
    rejectionCloseDays: row?.rejectionCloseDays || DEFAULT_REJECTION_CLOSE_DAYS,
    staleCloseDays: row?.staleCloseDays || DEFAULT_STALE_CLOSE_DAYS,
  };
}
