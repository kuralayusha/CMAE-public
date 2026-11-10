import assert from "node:assert/strict";
import test from "node:test";
import { isPreparedMailFile } from "../../lib/tracker/clear-prepared";

test("isPreparedMailFile matches only the prepared template for that kind", () => {
  assert.equal(isPreparedMailFile("email_original.md", "application"), true);
  assert.equal(isPreparedMailFile("company_info.md", "application"), false);
  assert.equal(isPreparedMailFile("follow_up_1.md", "follow_up"), true);
  assert.equal(isPreparedMailFile("follow_up_2_translated.md", "follow_up"), true);
  assert.equal(isPreparedMailFile("thanks.md", "follow_up"), false);
  assert.equal(isPreparedMailFile("thanks.md", "thanks"), true);
  // Legacy Turkish file names (tesekkur = thanks, yanit = reply) must still be recognized.
  assert.equal(isPreparedMailFile("tesekkur_mail.md", "thanks"), true);
  assert.equal(isPreparedMailFile("reply.md", "reply"), true);
  assert.equal(isPreparedMailFile("yanit.md", "reply"), true);
  assert.equal(isPreparedMailFile("email_original.md", "reply"), false);
});
