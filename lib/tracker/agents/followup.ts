import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mailMessages, trackerItemMails, trackerItems } from "@/lib/db/schema";
import {
  formatPreferencesForApplication,
  formatPreferencesForReply,
} from "@/lib/settings/preferences";
import { getJobPreferences, getSettingsRow } from "@/lib/settings/service";
import {
  extractSendLanguage,
  sameLanguage,
} from "@/lib/mail/lang";
import {
  applySignatureToMailDraft,
  EMAIL_SIGNATURE_PROMPT_RULES,
} from "@/lib/mail/signature";
import {
  createCompanyFolder,
  getWorkspaceRoot,
  writeFile,
} from "@/lib/research/workspace";
import { assertItemActiveForDrafts } from "../inactive";
import { askTrackerLlm } from "../llm";
import {
  findEmailDraftInFolder,
  formatSubjectBody,
  parseSubjectBody,
} from "../parse-mail-md";
import { replySubject, resolveThreadReplyTarget } from "../reply-thread";
import type { DraftKind } from "../types";

const MAIL_FIELD_RULES = `
CRITICAL — SUBJECT and BODY are final mail fields.

ABSOLUTE RULES:
- NEVER put notes, comments, TODOs, or meta text inside SUBJECT or BODY.
- NEVER invent facts. Omit unknown details.
- NEVER write placeholders like [Name], [Company], TBD, TODO, N/A, "unknown".
- If a detail is missing: OMIT it. Do not invent. Do not annotate the gap.
- Output format exactly:

SUBJECT: <one line>
BODY:
<full body>

${EMAIL_SIGNATURE_PROMPT_RULES}
`.trim();

/** Craft guide — short, low-pressure in-thread follow-up after no reply. */
const FOLLOW_UP_CRAFT_GUIDE = `
FOLLOW-UP CRAFT (follow closely — even shorter than the first application mail):

LENGTH & STRUCTURE
- Ideal: 50–80 words. Hard cap ~100. Must feel shorter than the original application.
- 2–3 short sentences; a single short paragraph is fine.
- Easy to answer in seconds — no long explanations.

THREADING (subject)
- This is an in-thread REPLY. SUBJECT must continue the prior thread with Re: …
- Prefer the thread anchor subject (e.g. "Re: Spontane Başvuru – …"). Do not invent a new subject that breaks context.
- The system may normalize Re:; still write a proper reply subject, never a brand-new cold subject.

BODY STRUCTURE (in this order)
1) Greeting: Use the real name if known. Otherwise a natural generic greeting for the language ("Sayın İlgili" / "Dear Hiring Team"). Never invent a name.
2) Soft reminder (1 sentence): Briefly mention the earlier application to this company — no accusation.
3) Empathy / tone: Acknowledge they may be busy ("yoğunluğunuzu biliyorum" / equivalent). Never "you didn't reply" / "did you see my email?" / "still waiting".
4) Optional new value (1 sentence, only if grounded in CV/notes/research): a new win, certificate, project, or a concrete company news/project note. If none is known, SKIP — do not invent.
5) Low-pressure ask (1 sentence): e.g. open to a short chat, or happy to be considered if a fitting role opens.
6) Mention CV is attached again (so they need not dig in the thread).
7) Thank them and close warmly ("Teşekkürler…" / "Thanks…" / language-appropriate), then exactly one closing line per SIGNATURE RULES (system appends the real signature).

TONE
- Kind, light, professional — not stiff, not pleading, not passive-aggressive.
- Do NOT copy-paste the first mail. Do NOT restate the whole CV.
- Do NOT complain, guilt-trip, or apply pressure across channels in the text.

LANGUAGE
- Match the thread language when clear; otherwise preferred language.
- Spelling must be flawless; company name exact.
`.trim();

function readOptional(folder: string, name: string): string {
  const full = path.join(folder, name);
  if (!fs.existsSync(full)) return "";
  try {
    return fs.readFileSync(full, "utf8").slice(0, 4000);
  } catch {
    return "";
  }
}

function existingFolder(workspaceFolder: string | null): string | null {
  if (!workspaceFolder) return null;
  const full = path.join(getWorkspaceRoot(), workspaceFolder);
  if (!fs.existsSync(full)) return null;
  return full;
}

/**
 * Use linked workspace, or create `N- Company` under workspace/ and attach it.
 */
async function ensureWorkspaceFolder(item: {
  id: number;
  company: string;
  position: string | null;
  primaryTo: string | null;
  workspaceFolder: string | null;
}): Promise<string> {
  const existing = existingFolder(item.workspaceFolder);
  if (existing) return existing;

  const created = await createCompanyFolder(item.company || "Company");
  const notes = [
    `# ${item.company}`,
    item.position ? `Position: ${item.position}` : null,
    item.primaryTo ? `Contact: ${item.primaryTo}` : null,
    "",
    "This folder was auto-created from the tracker (mail prepare).",
  ]
    .filter(Boolean)
    .join("\n");

  await writeFile(created.folderPath, "summary.md", `${notes}\n`);
  if (item.primaryTo) {
    await writeFile(
      created.folderPath,
      "contact.md",
      `Primary: ${item.primaryTo}\nCompany: ${item.company}\n`,
    );
  }

  getDb()
    .update(trackerItems)
    .set({
      workspaceFolder: created.folderName,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(trackerItems.id, item.id))
    .run();

  return created.folderPath;
}

async function recentMailsForItem(itemId: number) {
  const db = getDb();
  const links = db
    .select()
    .from(trackerItemMails)
    .where(eq(trackerItemMails.itemId, itemId))
    .all();
  const mails = [];
  for (const link of links) {
    const m = db
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.id, link.mailId))
      .get();
    if (m) mails.push(m);
  }
  return mails
    .sort((a, b) => a.dateIso.localeCompare(b.dateIso))
    .slice(-6)
    .map((m) => ({
      folder: m.folder,
      from: m.fromAddr,
      to: m.toAddr,
      subject: m.subject,
      date: m.dateIso,
      snippet: m.snippet || m.bodyText.slice(0, 300),
    }));
}

export async function prepareDraftForItem(
  itemId: number,
  kind: Exclude<DraftKind, "application">,
): Promise<{ fileName: string; subject: string; workspaceFolder: string }> {
  const db = getDb();
  const item = db
    .select()
    .from(trackerItems)
    .where(eq(trackerItems.id, itemId))
    .get();
  if (!item) throw new Error("Tracker item not found");
  assertItemActiveForDrafts(itemId);

  if (kind === "follow_up" && item.status !== "follow_up_due") {
    throw new Error(
      "Follow-up is currently locked — wait 7 days after the last follow-up (or follow-up day has not arrived yet)",
    );
  }

  const folder = await ensureWorkspaceFolder(item);
  const settings = getSettingsRow();
  const userLang = settings?.preferredLanguage || "en";
  const userName = settings?.fullName || "";
  // Prefer original application draft as context (same as ready_to_send)
  const originalApp = findEmailDraftInFolder(folder, userLang, {
    preferSiteLanguage: true,
  });
  const recent = await recentMailsForItem(itemId);
  const thread = resolveThreadReplyTarget(itemId);
  const replyTo =
    thread?.to || item.primaryTo || "unknown";
  const contactNotes =
    readOptional(folder, "contact.md") ||
    readOptional(folder, "iletisim.md");
  const summaryNotes =
    readOptional(folder, "summary.md") || readOptional(folder, "ozet.md");

  let intent: string;
  let fileName: string;
  let translatedFileName: string;
  let craftExtra = "";
  if (kind === "follow_up") {
    const n = Math.max(1, (item.followUpCount || 0) + 1);
    fileName = `follow_up_${n}.md`;
    translatedFileName = `follow_up_${n}_translated.md`;
    intent = `Write follow-up email #${n} after no reply. Follow FOLLOW-UP CRAFT strictly. In-thread REPLY — keep context with Re: subject. Shorter than the first mail; polite, low-pressure, easy to answer.`;
    craftExtra = `\n${FOLLOW_UP_CRAFT_GUIDE}\n`;
  } else if (kind === "thanks") {
    fileName = "thanks.md";
    translatedFileName = "thanks_translated.md";
    intent =
      "Write a short thank-you email after a rejection. Gracious, leave door open, no bitterness. In-thread reply to the rejection mail.";
  } else {
    fileName = "reply.md";
    translatedFileName = "reply_translated.md";
    intent =
      "Write a reply to their latest inbound message. Be professional and specific to their ask (interview scheduling, questions, offer discussion, salary/notice/work-type questions, etc.). If they ask about salary, notice, start date, or employment type, answer from Candidate preferences below — never invent figures.";
  }

  const prefs = getJobPreferences();
  const prefsBlock =
    kind === "reply"
      ? formatPreferencesForReply(prefs, "en")
      : formatPreferencesForApplication(prefs, "en");

  const prompt = `${MAIL_FIELD_RULES}
${craftExtra}
Write the email in the thread language when clear; otherwise use language code "${userLang}".
This draft is the ORIGINAL that will be sent — match the recipient's language.
Candidate name: ${userName || "(from CV/signature if known)"}
Company: ${item.company}
Position: ${item.position || "unknown"}
Reply-To address (latest SENT/INBOX counterpart): ${replyTo}
Thread anchor subject: ${thread?.anchorSubject || "(none)"}
Thread anchor folder: ${thread?.anchorFolder || "(none)"}

Candidate preferences:
${prefsBlock}

Task: ${intent}
SUBJECT must continue the thread (Re: …) using the anchor subject when possible — never start a new cold thread.

Original application draft (if any) — use only as context; do NOT copy it for a follow-up:
${originalApp ? `SUBJECT: ${originalApp.subject}\nBODY:\n${originalApp.body}` : "(none)"}

Contact notes:
${contactNotes || "(none)"}

Summary:
${summaryNotes || "(none)"}

Recent related emails (JSON):
${JSON.stringify(recent, null, 2)}

After SUBJECT/BODY, add exactly one extra line (not inside BODY):
SEND_LANGUAGE: <iso639-1 code of the language you wrote the email in, e.g. en, tr, de>
`;

  const rawText = await askTrackerLlm(prompt);
  const { text, language: sendLanguage } = extractSendLanguage(rawText);
  const parsed = parseSubjectBody(text);
  if (!parsed) {
    throw new Error("Agent could not produce SUBJECT/BODY");
  }

  const subjectThreaded = replySubject(
    parsed.subject,
    thread?.anchorSubject,
  );

  const withSig = applySignatureToMailDraft(
    formatSubjectBody(subjectThreaded, parsed.body),
    settings?.emailSignature,
  );
  const signed = parseSubjectBody(withSig);
  const subjectOut = signed?.subject || subjectThreaded;
  const toWrite = signed
    ? formatSubjectBody(signed.subject, signed.body)
    : withSig;
  fs.writeFileSync(
    path.join(/*turbopackIgnore: true*/ folder, fileName),
    toWrite,
    "utf8",
  );

  // Skip translate LLM + *_translated.md only when we know send lang == user lang
  const skipTranslate =
    Boolean(sendLanguage) && sameLanguage(sendLanguage, userLang);
  if (!skipTranslate) {
    try {
      const translatePrompt = `${MAIL_FIELD_RULES}

Rewrite the following email into language code "${userLang}" (natural tone for that language).
Keep the same facts, structure, threading subject (Re:), and length discipline.
Do not invent claims. Output SUBJECT:/BODY: only.

Source:
${toWrite}
`;
      const translatedRaw = await askTrackerLlm(translatePrompt);
      const translatedParsed = parseSubjectBody(translatedRaw);
      if (translatedParsed) {
        const translatedSigned = applySignatureToMailDraft(
          formatSubjectBody(translatedParsed.subject, translatedParsed.body),
          settings?.emailSignature,
        );
        fs.writeFileSync(
          path.join(/*turbopackIgnore: true*/ folder, translatedFileName),
          `# Translated for user (${userLang})\n\n${translatedSigned}`,
          "utf8",
        );
      }
    } catch {
      /* translated copy is best-effort */
    }
  }

  const patch: Partial<typeof trackerItems.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };
  if (kind === "follow_up") patch.hasFollowUpDraft = 1;
  if (kind === "thanks") patch.hasThanksDraft = 1;
  if (kind === "reply") patch.hasReplyDraft = 1;
  db.update(trackerItems).set(patch).where(eq(trackerItems.id, itemId)).run();

  const workspaceFolder =
    db
      .select()
      .from(trackerItems)
      .where(eq(trackerItems.id, itemId))
      .get()?.workspaceFolder || path.basename(folder);

  return { fileName, subject: subjectOut, workspaceFolder };
}
