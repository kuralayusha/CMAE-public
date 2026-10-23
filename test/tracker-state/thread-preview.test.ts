import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGmailThreadPreviews,
  mailOpeningPreview,
  threadKeyOf,
} from "../../lib/tracker/gmail-links";

test("mailOpeningPreview does not split dates or quoted-printable breaks", () => {
  const text = mailOpeningPreview(
    "Hallo, am 24. September hatte ich mich beworben. Bitte um eine Rückmeldung. Rol=\nle.",
  );
  assert.equal(
    text,
    "Hallo, am 24. September hatte ich mich beworben. Bitte um eine Rückmeldung.",
  );
});

test("mailOpeningPreview decodes html entities", () => {
  assert.equal(
    mailOpeningPreview("Hallo&nbsp;jane, vielen Dank f&uuml;r Ihre Bewerbung."),
    "Hallo jane, vielen Dank für Ihre Bewerbung.",
  );
});

test("mailOpeningPreview repairs quoted-printable leftovers and markup", () => {
  assert.equal(
    mailOpeningPreview(
      "Hallo jane, vielen Dank f=FCr Dein Interesse an einer T=E4tigkeit beim Beispiel AG = =96 wir freuen uns sehr =FCber Deine Bewerbung!",
    ),
    "Hallo jane, vielen Dank für Dein Interesse an einer Tätigkeit beim Beispiel AG – wir freuen uns sehr über Deine Bewerbung!",
  );
  assert.equal(
    mailOpeningPreview(
      "Thank you for the Staff Engineer position= at Acme Corp. We=92re happy you applied and apprec= iate the note.",
    ),
    "Thank you for the Staff Engineer position at Acme Corp. We’re happy you applied and appreciate the note.",
  );
  assert.equal(
    mailOpeningPreview(
      "Upcoming e= vents // Week of Sep 21&zwnj; &zwnj; = &zwnj;&nbs= p;",
    ),
    "Upcoming events // Week of Sep 21",
  );
  assert.match(
    mailOpeningPreview(
      'Danke für die Position &bdquo;Softwareentwickler&ldquo; und das damit verbundene Interesse.',
    ),
    /„Softwareentwickler“/,
  );
  assert.equal(
    mailOpeningPreview(
      "= Hallo Jane, noch einmal vielen Dank für deine Bewerbung.",
    ),
    "Hallo Jane, noch einmal vielen Dank für deine Bewerbung.",
  );
  assert.equal(
    mailOpeningPreview(
      "Wir bestätigen deinen Term= in am Montag. Das verbundene= Interesse bleibt.",
    ),
    "Wir bestätigen deinen Termin am Montag. Das verbundene Interesse bleibt.",
  );
  assert.equal(
    mailOpeningPreview(
      'Hello jane, <span style="font-family:Arial,Helvetica,sans-serif;font-size:x-sma',
    ),
    "Hello jane,",
  );
});

test("mailOpeningPreview keeps the first sentences and drops the quote", () => {
  const text = mailOpeningPreview(
    "Thanks for the update. Can we meet Tuesday? On Mon, Ada wrote: the old thread continues here forever.",
  );
  assert.equal(text, "Thanks for the update. Can we meet Tuesday?");
});

test("buildGmailThreadPreviews groups by thread and shows the other person", () => {
  const threads = buildGmailThreadPreviews(
    [
      {
        threadId: "10",
        messageId: "<a@x>",
        dateIso: "2026-01-01T00:00:00.000Z",
        subject: "Application",
        fromAddr: "Me <me@x.com>",
        toAddr: "Ada Lovelace <ada@co.com>",
        folder: "SENT",
        snippet: "I am applying for the role. I have shipped similar work.",
      },
      {
        threadId: "10",
        messageId: "<b@x>",
        dateIso: "2026-01-02T00:00:00.000Z",
        subject: "Re: Application",
        fromAddr: "Ada Lovelace <ada@co.com>",
        toAddr: "me@x.com",
        folder: "INBOX",
        snippet: "Thanks for applying. Are you free next week?",
      },
      {
        threadId: "20",
        messageId: "<c@x>",
        dateIso: "2026-02-01T00:00:00.000Z",
        subject: "Fwd: Take-home",
        fromAddr: "Sam <sam@co.com>",
        toAddr: "me@x.com",
        folder: "INBOX",
        snippet: "Please find the exercise attached. Send it by Friday.",
      },
    ],
    "me@x.com",
    "me@x.com",
  );

  assert.equal(threads.length, 2);
  assert.equal(threads[0]?.key, threadKeyOf({ threadId: "20", messageId: "<c@x>" }));
  assert.equal(threads[0]?.subject, "Take-home");
  assert.equal(threads[0]?.from, "Sam");
  assert.match(threads[0]?.preview || "", /^Please find the exercise/);
  assert.equal(threads[1]?.subject, "Application");
  assert.equal(threads[1]?.from, "Ada Lovelace");
  assert.match(threads[1]?.preview || "", /^Thanks for applying/);
  assert.match(threads[0]?.url || "", /#all\//);
});
