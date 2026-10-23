/**
 * Drafts reconcile grace + Message-ID matching contracts.
 *   npm run test:tracker-state
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  DRAFT_MISSING_MIN_CHECKS,
  DRAFT_MISSING_MIN_MS,
  normalizeDraftMessageId,
} from "../../lib/tracker/drafts-reconcile";

test("missing draft grace needs more than one check and a delay", () => {
  // A single reconcile before SENT lands in mail_messages must not delete.
  assert.ok(DRAFT_MISSING_MIN_CHECKS >= 2);
  assert.ok(DRAFT_MISSING_MIN_MS >= 60_000);
});

test("normalizeDraftMessageId strips brackets and case", () => {
  assert.equal(
    normalizeDraftMessageId("<CMAE-AbC@cmae.local>"),
    "cmae-abc@cmae.local",
  );
  assert.equal(
    normalizeDraftMessageId("cmae-abc@cmae.local"),
    "cmae-abc@cmae.local",
  );
  assert.equal(normalizeDraftMessageId("  <x@y>  "), "x@y");
  assert.equal(normalizeDraftMessageId(null), "");
});
