import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bumpTrackerRevision } from "@/lib/db/revision";
import { mailAssignments, mailMessages, trackerItems } from "@/lib/db/schema";
import { t } from "@/lib/i18n/t";
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
import { detectSiteLanguageFromFolder, getBestCvText } from "@/lib/cv/library";
import {
  buildApplicationMailPrompt,
  buildJobContext,
  buildMailTranslatePrompt,
  canonicalizeMailDraft,
} from "@/lib/research/agents/application-mail";
import { getJob } from "@/lib/research/events";
import { WS } from "@/lib/workspace/filenames";
import { markLiveDraftSuperseded } from "../gmail-drafts-store";
import { assertItemActiveForDrafts } from "../inactive";
import { currentUsageRunId, withUsageRunAsync } from "@/lib/ai-usage";
import { askTrackerLlm } from "../llm";
import {
  findEmailDraftInFolder,
  formatSubjectBody,
  parseSubjectBody,
} from "../parse-mail-md";
import { threadKeyOf } from "../gmail-links";
import {
  parsePendingGmailDraft,
  withoutPendingGmailDraft,
} from "../pending-draft";
import { replySubject, resolveThreadReplyTarget } from "../reply-thread";
import { withReplyThreadKey } from "../reply-thread-key";
import {
  formatUserNotesBlock,
  getVariantDef,
  MAIL_VOICE_RULES,
  resolveVariant,
  type DraftPrepareKind,
  type DraftVariantId,
} from "../draft-variants";
import type { DraftKind } from "../types";

const MAIL_FIELD_RULES = `
CRITICAL. SUBJECT and BODY are final mail fields.

ABSOLUTE RULES:
- NEVER put notes, comments, TODOs, or meta text inside SUBJECT or BODY.
- NEVER invent facts. Omit unknown details.
- NEVER write placeholders like [Name], [Company], TBD, TODO, N/A, "unknown".
- If a detail is missing: OMIT it. Do not invent. Do not annotate the gap.
- Do NOT wrap labels in markdown (**SUBJECT:** is forbidden). Plain "SUBJECT:" / "BODY:" only.
- NEVER put SUBJECT and BODY on the same line. Never write "SUBJECT: … BODY: …".
- Output format EXACTLY (newlines matter, copy this shape):

SUBJECT: <one line>
BODY:
<full body>

Line 1 = SUBJECT: + subject text.
Line 2 = BODY: alone (nothing after the colon on that line).
Line 3+ = the email body only.

${EMAIL_SIGNATURE_PROMPT_RULES}
`.trim();

export type PrepareDraftOptions = {
  variant?: string | null;
  userNote?: string | null;
  /** Optional timeline kinds for default variant when none provided. */
  eventKinds?: string[];
  /** `t:` / `m:` thread to reply inside. Omit to use the latest mail. */
  threadKey?: string | null;
};

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
  bumpTrackerRevision("mutation", "upsert", [item.id]);

  return created.folderPath;
}

async function recentMailsForItem(itemId: number, threadKey?: string | null) {
  const db = getDb();
  const links = db
    .select()
    .from(mailAssignments)
    .where(eq(mailAssignments.itemId, itemId))
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
  const sorted = mails.sort((a, b) => a.dateIso.localeCompare(b.dateIso));
  const mapMail = (m: (typeof sorted)[number]) => ({
    threadKey: threadKeyOf(m),
    folder: m.folder,
    from: m.fromAddr,
    to: m.toAddr,
    subject: m.subject,
    date: m.dateIso,
    snippet: (m.snippet || m.bodyText).slice(0, 300),
  });
  return {
    inThread: sorted
      .filter((m) => !threadKey || threadKeyOf(m) === threadKey)
      .slice(-6)
      .map(mapMail),
    other: threadKey
      ? sorted
          .filter((m) => threadKeyOf(m) !== threadKey)
          .slice(-4)
          .map(mapMail)
      : [],
  };
}

export async function prepareDraftForItem(
  itemId: number,
  kind: Exclude<DraftKind, "application">,
  options: PrepareDraftOptions = {},
): Promise<{
  fileName: string;
  subject: string;
  workspaceFolder: string;
  variant: DraftVariantId;
}> {
  if (currentUsageRunId()) {
    return prepareDraftForItemBody(itemId, kind, options);
  }
  return withUsageRunAsync(globalThis.crypto.randomUUID(), () =>
    prepareDraftForItemBody(itemId, kind, options),
  );
}

async function prepareDraftForItemBody(
  itemId: number,
  kind: Exclude<DraftKind, "application">,
  options: PrepareDraftOptions = {},
): Promise<{
  fileName: string;
  subject: string;
  workspaceFolder: string;
  variant: DraftVariantId;
}> {
  const db = getDb();
  const item = db
    .select()
    .from(trackerItems)
    .where(eq(trackerItems.id, itemId))
    .get();
  if (!item) throw new Error(t("tracker.error.notFound"));
  assertItemActiveForDrafts(itemId);

  if (kind === "follow_up" && item.status !== "follow_up_due") {
    throw new Error(t("tracker.error.followUpLocked"));
  }

  const prepareKind = kind as DraftPrepareKind;
  if (options.variant && !getVariantDef(prepareKind, options.variant)) {
    throw new Error(t("tracker.error.invalidVariant"));
  }

  const variantDef = resolveVariant(prepareKind, options.variant, {
    followUpCount: item.followUpCount || 0,
    eventKinds: options.eventKinds,
  });

  const folder = await ensureWorkspaceFolder(item);
  const settings = getSettingsRow();
  const userLang = settings?.preferredLanguage || "en";
  const userName = settings?.fullName || "";
  // Prefer original application draft as context (same as ready_to_send)
  const originalApp = findEmailDraftInFolder(folder, userLang, {
    preferSiteLanguage: true,
  });
  const thread = resolveThreadReplyTarget(itemId, options.threadKey);
  const recent = await recentMailsForItem(itemId, thread?.key);
  const replyTo =
    thread?.to || item.primaryTo || "unknown";
  const contactNotes =
    readOptional(folder, "contact.md") ||
    readOptional(folder, "iletisim.md");
  const summaryNotes =
    readOptional(folder, "summary.md") || readOptional(folder, "ozet.md");

  let fileName: string;
  let translatedFileName: string;
  if (kind === "follow_up") {
    const n = Math.max(1, (item.followUpCount || 0) + 1);
    fileName = `follow_up_${n}.md`;
    translatedFileName = `follow_up_${n}_translated.md`;
  } else if (kind === "thanks") {
    fileName = "thanks.md";
    translatedFileName = "thanks_translated.md";
  } else {
    fileName = "reply.md";
    translatedFileName = "reply_translated.md";
  }

  const intent =
    kind === "follow_up"
      ? `${variantDef.intent} This is follow-up email #${Math.max(1, (item.followUpCount || 0) + 1)}.`
      : variantDef.intent;
  const craftExtra = `\n${variantDef.craftGuide}\n`;
  const userNotesBlock = formatUserNotesBlock(options.userNote || "");

  const prefs = getJobPreferences();
  const prefsBlock =
    kind === "reply"
      ? formatPreferencesForReply(prefs, "en")
      : formatPreferencesForApplication(prefs, "en");

  const prompt = `${MAIL_FIELD_RULES}

${MAIL_VOICE_RULES}
${craftExtra}
Write the email in the thread language when clear; otherwise use language code "${userLang}".
This draft is the original that will be sent. Match the recipient's language.
Write the way a colleague would: short, clear, correct. Do not stretch it.
Candidate name: ${userName || "(from CV/signature if known)"}
Company: ${item.company}
Position: ${item.position || "unknown"}
Reply-To address (latest SENT/INBOX counterpart): ${replyTo}
Thread anchor subject: ${thread?.anchorSubject || "(none)"}
Thread anchor folder: ${thread?.anchorFolder || "(none)"}
Variant: ${variantDef.id}

Candidate preferences:
${prefsBlock}
${userNotesBlock}
Task: ${intent}
If a user note is present, that note decides tone, content, and format. The task above only sets the purpose.

Original application draft (if any). Use only as context. Do not copy it into a follow-up:
${originalApp ? `SUBJECT: ${originalApp.subject}\nBODY:\n${originalApp.body}` : "(none)"}

Contact notes:
${contactNotes || "(none)"}

Summary:
${summaryNotes || "(none)"}

Mails in the thread you must reply to (JSON):
${JSON.stringify(recent.inThread, null, 2)}
${
  recent.other.length
    ? `\nOther conversations on this application. Context only, do not answer them:\n${JSON.stringify(recent.other, null, 2)}`
    : ""
}

After SUBJECT/BODY, add exactly one extra line (not inside BODY):
SEND_LANGUAGE: <iso639-1 code of the language you wrote the email in, e.g. en, tr, de>
`;

  const rawText = await askTrackerLlm(prompt, { feature: "tracker.followup" });
  const { text, language: sendLanguage } = extractSendLanguage(rawText);
  const parsed = parseSubjectBody(text);
  if (!parsed) {
    throw new Error(t("tracker.error.agentSubjectBody"));
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
  try {
    const { noteWorkspaceFileWrite } = await import(
      "@/lib/tracker/workspace-index"
    );
    noteWorkspaceFileWrite(folder, fileName, toWrite);
  } catch (err) {
    console.error("[prepare] workspace index write failed", err);
  }

  // Skip translate LLM + *_translated.md only when we know send lang == user lang
  const skipTranslate =
    Boolean(sendLanguage) && sameLanguage(sendLanguage, userLang);
  if (!skipTranslate) {
    try {
      const translatePrompt = `${MAIL_FIELD_RULES}

Rewrite the following email into language code "${userLang}".
Keep the same facts, the same short length, and the same plain voice.
Do not make it more formal, longer, or more polished.
Keep punctuation to period, comma, and question mark.
Do not invent claims. Output SUBJECT:/BODY: only.

Source:
${toWrite}
`;
      const translatedRaw = await askTrackerLlm(translatePrompt, { feature: "tracker.followup" });
      const translatedParsed = parseSubjectBody(translatedRaw);
      if (translatedParsed) {
        const translatedSigned = applySignatureToMailDraft(
          formatSubjectBody(translatedParsed.subject, translatedParsed.body),
          settings?.emailSignature,
        );
        const translatedBody = `# Translated for user (${userLang})\n\n${translatedSigned}`;
        fs.writeFileSync(
          path.join(/*turbopackIgnore: true*/ folder, translatedFileName),
          translatedBody,
          "utf8",
        );
        try {
          const { noteWorkspaceFileWrite } = await import(
            "@/lib/tracker/workspace-index"
          );
          noteWorkspaceFileWrite(folder, translatedFileName, translatedBody);
        } catch {
          /* index best-effort */
        }
      }
    } catch {
      /* translated copy is best-effort */
    }
  }

  // Bookkeeping must not fail the request: the mail file is already on disk.
  // A throw here used to return 500 before Gmail Drafts was saved, leaving
  // only the orange ring.
  try {
    markLiveDraftSuperseded(itemId, kind);
    const pending = parsePendingGmailDraft(item.notesJson);
    let notesJson = item.notesJson;
    if (pending?.kind === kind) {
      notesJson = withoutPendingGmailDraft(notesJson);
    }
    if (thread?.key) {
      notesJson = withReplyThreadKey(notesJson, kind, thread.key);
    }
    if (notesJson !== item.notesJson) {
      db.update(trackerItems)
        .set({ notesJson })
        .where(eq(trackerItems.id, itemId))
        .run();
    }

    // Flags derived from workspace_files on read (Faz 8). Bump revision for clients.
    bumpTrackerRevision("mutation", "upsert", [itemId]);
  } catch (err) {
    console.error("[prepare] post-write bookkeeping failed", err);
  }

  const workspaceFolder =
    db
      .select()
      .from(trackerItems)
      .where(eq(trackerItems.id, itemId))
      .get()?.workspaceFolder || path.basename(folder);

  return {
    fileName,
    subject: subjectOut,
    workspaceFolder,
    variant: variantDef.id,
  };
}

/**
 * Re-write the research application email from folder notes (after clear-prepared).
 * Uses company_info / summary / contact — not a full research re-run.
 */
export async function prepareApplicationDraftForItem(itemId: number): Promise<{
  fileName: string;
  subject: string;
  workspaceFolder: string;
}> {
  if (currentUsageRunId()) {
    return prepareApplicationDraftForItemBody(itemId);
  }
  return withUsageRunAsync(globalThis.crypto.randomUUID(), () =>
    prepareApplicationDraftForItemBody(itemId),
  );
}

async function prepareApplicationDraftForItemBody(itemId: number): Promise<{
  fileName: string;
  subject: string;
  workspaceFolder: string;
}> {
  const db = getDb();
  const item = db
    .select()
    .from(trackerItems)
    .where(eq(trackerItems.id, itemId))
    .get();
  if (!item) throw new Error(t("tracker.error.notFound"));
  assertItemActiveForDrafts(itemId);
  if (item.status !== "ready_to_send") {
    throw new Error(t("tracker.error.applicationPrepareLocked"));
  }

  const folder = await ensureWorkspaceFolder(item);
  const settings = getSettingsRow();
  const userLang = settings?.preferredLanguage || "en";
  const userName = settings?.fullName || "";
  const contactNotes =
    readOptional(folder, "contact.md") ||
    readOptional(folder, "iletisim.md");
  const summaryNotes =
    readOptional(folder, "summary.md") || readOptional(folder, "ozet.md");
  const companyNotes =
    readOptional(folder, "company_info.md") ||
    readOptional(folder, "sirket_bilgileri.md") ||
    summaryNotes;
  if (!companyNotes.trim() && !contactNotes.trim() && !summaryNotes.trim()) {
    throw new Error(t("tracker.error.applicationPrepareNoResearch"));
  }

  // Same prompt system as the research writer (MAIL CRAFT + field rules + CV),
  // so a mail rewritten after the user deleted it matches a fresh research run.
  const cvText =
    (
      await getBestCvText({
        preferredLanguage: userLang,
        position: item.position,
      })
    )?.trim() ||
    settings?.cvText?.trim() ||
    "";
  if (!cvText) throw new Error(t("research.error.cvMissing"));

  const siteLanguage =
    detectSiteLanguageFromFolder(folder) ||
    readOptional(folder, WS.companyInfo)
      .split("\n", 1)[0]
      ?.match(/\(([a-zA-Z]{2,3})\)\s*$/)?.[1]
      ?.toLowerCase() ||
    userLang;
  const jobLinks =
    readOptional(folder, WS.jobLinks) ||
    readOptional(folder, "basvuru_linkleri.md");
  // Matched roles are numbered "## 1. Title" sections; the no-match note has none.
  const matchedRoles = /^## \d+\./m.test(jobLinks) ? jobLinks : "";
  const replyTo = item.primaryTo || item.selectedRecipient || "unknown";

  const prompt = buildApplicationMailPrompt({
    siteLanguage,
    fullName: userName || "Candidate",
    email: settings?.gmailAddress || "",
    companyName: item.company,
    url: (item.researchJobId && getJob(item.researchJobId)?.url) || "(unknown)",
    recipient: replyTo,
    jobContext: buildJobContext(matchedRoles, ""),
    prefsBlock: formatPreferencesForApplication(
      getJobPreferences(),
      siteLanguage || userLang,
    ),
    cvText,
    researchMd: [
      companyNotes,
      contactNotes && `Contact notes:\n${contactNotes}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });

  const rawText = await askTrackerLlm(prompt, { feature: "research.writer" });
  const parsed = parseSubjectBody(
    canonicalizeMailDraft(rawText, userName || null),
  );
  if (!parsed) {
    throw new Error(t("tracker.error.agentSubjectBody"));
  }

  const withSig = applySignatureToMailDraft(
    formatSubjectBody(parsed.subject, parsed.body),
    settings?.emailSignature,
  );
  const signed = parseSubjectBody(withSig);
  const subjectOut = signed?.subject || parsed.subject;
  const toWrite = signed
    ? formatSubjectBody(signed.subject, signed.body)
    : withSig;
  const fileName = "email_original.md";
  const header = `# Application mail — original / site language\n\n`;
  fs.writeFileSync(
    path.join(/*turbopackIgnore: true*/ folder, fileName),
    `${header}${toWrite}\n`,
    "utf8",
  );
  try {
    const { noteWorkspaceFileWrite } = await import(
      "@/lib/tracker/workspace-index"
    );
    noteWorkspaceFileWrite(folder, fileName, `${header}${toWrite}\n`);
  } catch (err) {
    console.error("[prepare-application] workspace index write failed", err);
  }

  const skipTranslate = sameLanguage(siteLanguage, userLang);
  if (!skipTranslate) {
    try {
      const translatePrompt = buildMailTranslatePrompt({
        preferredLang: userLang,
        draft: toWrite,
      });
      const translatedRaw = await askTrackerLlm(translatePrompt, {
        feature: "research.writer",
      });
      const translatedParsed = parseSubjectBody(translatedRaw);
      if (translatedParsed) {
        const translatedSigned = applySignatureToMailDraft(
          formatSubjectBody(translatedParsed.subject, translatedParsed.body),
          settings?.emailSignature,
        );
        const translatedFileName = "email_translated.md";
        const translatedBody = `# Application mail — translated for user (${userLang})\n\n${translatedSigned}\n`;
        fs.writeFileSync(
          path.join(/*turbopackIgnore: true*/ folder, translatedFileName),
          translatedBody,
          "utf8",
        );
        try {
          const { noteWorkspaceFileWrite } = await import(
            "@/lib/tracker/workspace-index"
          );
          noteWorkspaceFileWrite(folder, translatedFileName, translatedBody);
        } catch {
          /* index best-effort */
        }
      }
    } catch {
      /* translated copy is best-effort */
    }
  }

  try {
    markLiveDraftSuperseded(itemId, "application");
    const pending = parsePendingGmailDraft(item.notesJson);
    if (pending?.kind === "application") {
      db.update(trackerItems)
        .set({ notesJson: withoutPendingGmailDraft(item.notesJson) })
        .where(eq(trackerItems.id, itemId))
        .run();
    }
    bumpTrackerRevision("mutation", "upsert", [itemId]);
  } catch (err) {
    console.error("[prepare-application] post-write bookkeeping failed", err);
  }

  const workspaceFolder =
    db
      .select()
      .from(trackerItems)
      .where(eq(trackerItems.id, itemId))
      .get()?.workspaceFolder || path.basename(folder);

  return { fileName, subject: subjectOut, workspaceFolder };
}
