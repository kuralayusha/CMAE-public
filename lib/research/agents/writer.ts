import { sameLanguage } from "@/lib/mail/lang";
import {
  applySignatureToMailDraft,
  EMAIL_SIGNATURE_PROMPT_RULES,
} from "@/lib/mail/signature";
import { formatPreferencesForApplication } from "@/lib/settings/preferences";
import { getJobPreferences, getSettingsRow } from "@/lib/settings/service";
import {
  formatSubjectBody,
  parseSubjectBody,
} from "@/lib/tracker/parse-mail-md";
import { throwIfCanceled } from "../cancel";
import type { RunContext } from "../context";
import { askLlm } from "../llm";
import { speak } from "../speak";
import { writeFile } from "../workspace";

/** Canonical SUBJECT:/BODY: so tracker draft picker never skips site language. */
function canonicalizeMailDraft(raw: string): string {
  const parsed = parseSubjectBody(raw);
  if (!parsed) return raw;
  return formatSubjectBody(parsed.subject, parsed.body);
}

/** Hard rules — draft is copy/paste or sync-to-Gmail ready. */
const MAIL_FIELD_RULES = `
CRITICAL — SUBJECT and BODY are final mail fields. The user will copy/paste or sync them into draft mode unchanged.

ABSOLUTE RULES for SUBJECT and BODY:
- NEVER put notes, comments, asides, TODOs, or meta text inside SUBJECT or BODY.
- NEVER write placeholders like [Name], [Company], TBD, TODO, N/A, "unknown", "bulunamadı", "ekle", "doldur", "(not found)", "(optional)", etc.
- NEVER explain missing info inside the mail (e.g. "I couldn't find…", "Not: …", "Note: …", "P.S. for the agent…").
- If you lack a fact (recipient name, role title, specific product detail): OMIT it. Do not invent. Do not annotate the gap.
- SUBJECT = only the subject line text. BODY = only the email body the recipient should read.
- Do NOT wrap labels in markdown (**SUBJECT:** is forbidden). Plain "SUBJECT:" / "BODY:" only.
- NEVER put SUBJECT and BODY on the same line. Never write "SUBJECT: … BODY: …".
- Output format EXACTLY (newlines matter — copy this shape):

SUBJECT: <one line, ready to send>
BODY:
<full body, ready to send>

Line 1 = SUBJECT: + subject text.
Line 2 = BODY: alone (nothing after the colon on that line).
Line 3+ = the email body only.
No other sections. No footnotes under BODY. No markdown titles, callouts, or process notes.

${EMAIL_SIGNATURE_PROMPT_RULES}
`.trim();

/** Craft guide — how a strong spontaneous / targeted application mail should read. */
const MAIL_CRAFT_GUIDE = `
MAIL CRAFT (follow closely — HR scans these in ~10–15 seconds):

LENGTH & FORMAT
- Ideal body length: 100–150 words. Hard cap: 200 words. Shorter is better than padded.
- Structure as 3–4 short paragraphs; each paragraph 2–3 sentences max.
- Plain text only: no HTML, Markdown bold/italic, colored text, tables, or image descriptions.
- Mobile-friendly: avoid long dense paragraphs.

SUBJECT LINE
- Short and specific: max 6–8 words.
- Prefer patterns like (fill with real role + candidate name, no brackets):
  - "Spontane Başvuru – Pazarlama Uzmanı / Ahmet Yılmaz"
  - "Experienced Marketing Candidate – Ahmet Yılmaz"
  - equivalent phrasing in the mail language
- Never use vague subjects: "Hello", "Hi", "Job application", "İş başvurusu", "Merhaba", "CV", "Application".
- If applying to a known open role, name that role (or closest accurate title) in the subject.

BODY STRUCTURE (in this order)
1) Greeting: Use the recipient's real name when known ("Sayın Ayşe Hanım" / "Dear Ms. …"). If only a generic inbox (info@, careers@, hr@), use a natural generic greeting for the language ("Sayın İlgili" / "Dear Hiring Team") — never invent a name.
2) Opening (1–2 sentences): Who you are and what you want (specific field/role — never "any position").
3) Value proposition (2–3 sentences): Strongest 1–2 experiences or wins from the CV; prefer quantified results when the CV has numbers. No fabricated metrics.
4) Why this company (1–2 sentences): One specific, research-backed note (product, project, value, news). Must sound researched, not copy-paste.
5) Closing (1–2 sentences): Open to a short conversation; if cold/no open role, state interest in being considered when a fitting role opens. Mention that the CV is attached (PDF) — do not invent attachment filenames beyond a natural "CV attached" line.
6) Then exactly one closing line per SIGNATURE RULES (system appends the real signature).

PERSONALIZATION & INTENT
- Personalize every mail: company name, sector, and a concrete interest point from research. Never generic template filler that could fit any company.
- State a clear target field/role. Prefer the matched open job when available; otherwise the closest CV-aligned field.
- Tone: professional but warm — not stiff, not pleading, not salesy.
- Language: write entirely in the required language (site language or preferred language, as instructed). Match formality to that culture.
- Spelling: flawless. Company name must match research exactly — misspelling the company is a critical failure.
- Body is the cover letter; do not propose a separate motivation letter.

COLD vs OPEN ROLE
- Open role: reference the role naturally; show fit without repeating the whole CV.
- Cold / no matching role: acknowledge you know there may be no open posting; still make a clear contribution case for a specific field.
`.trim();

export async function runWriter(ctx: RunContext) {
  const { jobId, user } = ctx;
  speak(jobId, "writer", "system", "── writer online · application mail");
  throwIfCanceled(jobId);

  if (ctx.redoFeedback.writer) {
    speak(jobId, "writer", "think", `Reviewer feedback: ${ctx.redoFeedback.writer}`);
  }

  const jobContext = ctx.jobFit?.hasMatchingJob
    ? `Open roles:\n${JSON.stringify(ctx.jobFit.jobs, null, 2)}`
    : "No matching open role — write a cold/initiative application.";

  const recipient =
    ctx.primaryEmail ||
    ctx.emails
      .map((e) => e.email)
      .slice(0, 3)
      .join(", ") ||
    "unknown";

  const prefsBlock = formatPreferencesForApplication(
    getJobPreferences(),
    ctx.siteLanguage || user.preferredLang,
  );

  ctx.draftSite = await askLlm(
    jobId,
    `You are an Application Writer specialist.
Write a personalized application email in language: ${ctx.siteLanguage} (match the website / company's working language).

Candidate: ${user.fullName} <${user.email}>
Company (TARGET from user URL ${ctx.url}): ${ctx.companyName}
Recipient hint: ${recipient}
Do not address or apply to a different company mentioned only in CV/site work history.
${jobContext}

Candidate job preferences (use notice period + work type when natural; do not dump salary):
${prefsBlock}

CV:
${user.cvText.slice(0, 7000)}

Company research:
${ctx.researchMd.slice(0, 4000)}

${ctx.redoFeedback.writer ? `CRITICAL — address this reviewer feedback: ${ctx.redoFeedback.writer}\n` : ""}

${MAIL_CRAFT_GUIDE}

${MAIL_FIELD_RULES}

Short, concrete, no fabricated experience. Follow MAIL CRAFT structure and length limits.`,
    `Mail draft (${ctx.siteLanguage})…`,
    "writer",
  );

  const sameLang = sameLanguage(ctx.siteLanguage, user.preferredLang);
  const signature = getSettingsRow()?.emailSignature ?? null;
  ctx.draftSite = canonicalizeMailDraft(
    applySignatureToMailDraft(ctx.draftSite, signature),
  );

  // Same language → no translate LLM call, no email_translated.md
  if (sameLang) {
    ctx.draftPreferred = ctx.draftSite;
  } else {
    ctx.draftPreferred = await askLlm(
      jobId,
      `Rewrite the email in preferred language code "${user.preferredLang}" (natural tone for that language).
Keep the same facts, structure, personalization, and length discipline as MAIL CRAFT.
Do not inflate length; do not add fabricated claims.

Source draft:
${ctx.draftSite}

${ctx.redoFeedback.writer ? `Also fix: ${ctx.redoFeedback.writer}\n` : ""}

${MAIL_CRAFT_GUIDE}

${MAIL_FIELD_RULES}`,
      `Mail (${user.preferredLang})…`,
      "writer",
    );
    ctx.draftPreferred = canonicalizeMailDraft(
      applySignatureToMailDraft(ctx.draftPreferred, signature),
    );
  }

  await writeFile(
    ctx.folderPath,
    "email_original.md",
    `# Application mail — original / site language (${ctx.siteLanguage})\n\n${ctx.draftSite}\n`,
  );

  if (!sameLang) {
    await writeFile(
      ctx.folderPath,
      "email_translated.md",
      `# Application mail — translated for user (${user.preferredLang})\n\n${ctx.draftPreferred}\n`,
    );
  }

  speak(
    jobId,
    "writer",
    "ok",
    sameLang
      ? "draft written (original; user language matches site)"
      : "drafts written (original + translated for user)",
  );
}
