/**
 * Settings day-range validation:
 *   npm run test:tracker-state
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_FOLLOW_UP_DAYS,
  DEFAULT_REJECTION_CLOSE_DAYS,
  DEFAULT_STALE_CLOSE_DAYS,
  STALE_CLOSE_DAYS_MIN,
  validateStatusDaySettings,
} from "../../lib/tracker/status-constants";

describe("validateStatusDaySettings", () => {
  it("accepts defaults", () => {
    const r = validateStatusDaySettings({
      followUpDays: DEFAULT_FOLLOW_UP_DAYS,
      rejectionCloseDays: DEFAULT_REJECTION_CLOSE_DAYS,
      staleCloseDays: DEFAULT_STALE_CLOSE_DAYS,
    });
    assert.equal(r.ok, true);
  });

  it("rejects followUpDays >= staleCloseDays", () => {
    const r = validateStatusDaySettings({
      followUpDays: 20,
      rejectionCloseDays: 10,
      staleCloseDays: 20,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "followUpBeforeStale");
  });

  it("rejects stale below post-follow-up cooldown+1", () => {
    const r = validateStatusDaySettings({
      followUpDays: 3,
      rejectionCloseDays: 10,
      staleCloseDays: STALE_CLOSE_DAYS_MIN - 1,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "staleCloseDaysRange");
  });
});
