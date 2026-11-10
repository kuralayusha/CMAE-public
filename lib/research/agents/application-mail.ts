import { EMAIL_SIGNATURE_PROMPT_RULES } from "@/lib/mail/signature";
import {
  formatSubjectBody,
  parseSubjectBody,
  repairShortenedFullName,
} from "@/lib/tracker/parse-mail-md";
import type { JobFitResult } from "../context";
import { OUTPUT_ONLY_RULES } from "./research";

/** Canonical SUBJECT:/BODY: so tracker draft picker never skips site language. */
export function canonicalizeMailDraft(raw: string, fullName?: string | null): string {
  const repaired = repairShortenedFullName(raw, fullName);
  const parsed = parseSubjectBody(repaired);
  if (!parsed) return repaired;
  return formatSubjectBody(
    repairShortenedFullName(parsed.subject, fullName),
    repairShortenedFullName(parsed.body, fullName),
  );
}

/**
 * Hard rules — draft is copy/paste or sync-to-Gmail ready.
 * Turkish placeholder/subject examples inside the prompt ("bulunamadı", "İş
 * başvurusu", ...) are intentional: drafts can be written in Turkish, so the
 * model must be told these non-English fillers are banned too.
 */
export const MAIL_FIELD_RULES = `
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

/**
 * Craft guide — a short human email, not a cover letter. Shape: who I am + why
 * this mail → fit with THIS company → one small ask. Written against the usual
 * AI tells (stock openers, flattery, dash-heavy rhythm, identical proof in
 * every mail), see the research notes in the commit that introduced it.
 */
export const MAIL_CRAFT_GUIDE = `
MAIL CRAFT — this is a short email from one professional to a stranger, NOT a cover letter. The reader skims it on a phone in about 10 seconds and has seen hundreds of AI-written applications.

SHAPE — exactly three short paragraphs after the greeting
1) WHO + WHY (1–2 sentences, about 30 words)
   - Say who the candidate is as a plain fact: job title, years or domain, city if relevant. Example shape: "Fullstack developer in Berlin, five years building B2B SaaS for public-sector clients."
   - Then say why this mail exists, tied to THIS company: the matched role title (only when MATCHED OPEN ROLES lists it), otherwise the field the candidate wants to work in at this company.
   - Never open with "my name is", "I am writing to", "I am reaching out", "I hope this finds you well", "Mein Name ist", "Hiermit bewerbe ich mich" or the equivalent in any language. The name is in the subject and the signature.
   - Never mention that no vacancy is listed, never apologise for writing unasked, never explain the lack of a posting.
2) FIT (2–3 sentences, about 50 words) — the only persuasion in the mail
   - Pattern: one concrete, verifiable fact about the company from the research (a product, client, project, technical problem or stated principle, named exactly) → the one thing the candidate has done that maps onto it, with one number or outcome from the CV.
   - Choose the ONE CV achievement closest to this company's domain. Do not reuse the same headline achievement for every company. Do not list skills or tools.
   - State the match in plain words ("That is the same problem I solved at X: …"), never with words like "resonates", "aligns" or "spricht mich an".
   - If the research has no concrete company detail, do not flatter: describe the sector problem plainly or leave the company reference out. Never invent or generalise.
3) ASK (1–2 short sentences)
   - One small, concrete next step ("Would a 15-minute call next week make sense?" or "Who on the engineering team should I talk to?").
   - Mention the attached CV (PDF) in one short clause. Availability or notice period only as one short clause, only if it fits; never a list of work modes.

LENGTH
- Body (greeting and signature excluded): 70–110 words. Hard cap 130. Shorter beats padded.
- Plain text only: no HTML, Markdown, bold, lists or tables.

SOUND LIKE A PERSON
- Plain, direct, specific. Concrete nouns, names and numbers. One idea per sentence. Mix short sentences with one medium one.
- State facts, do not announce feelings: write "I built X", never "I am passionate about X".
- Banned (in ANY language, including translations): excited, thrilled, passionate, eager, delighted, "I came across", "I am drawn to", resonates, "aligns (closely/perfectly) with", seamless, leverage, cutting-edge, innovative, dynamic, game-changer, proven track record, "I would welcome/value the opportunity", "spricht mich an", begeistert, Leidenschaft, "ich würde mich freuen", "freue mich sehr", "dazu könnte ich gern beitragen", "halten Sie mich gerne vorgemerkt", "mir ist bewusst, dass".
- No em dashes or en dashes inside sentences (use a comma, colon or full stop). No semicolon chains, no "not only … but also", no three-item lists of adjectives or skills, no rhetorical questions, no exclamation marks.
- No self-praise adjectives ("highly motivated", "results-driven", "team player"). A job title taken from the CV (for example Senior) is fine.
- Do not summarise the CV; it is attached.
- Spelling and grammar must be flawless. The company name must match the research exactly — misspelling it is a critical failure.

GREETING
- Use the recipient's real name when known ("Sehr geehrte Frau Müller", "Dear Ms. Müller"). Never guess a name or title.
- For a generic inbox (info@, careers@, hr@) address the team by company name ("Dear Acme team", "Sehr geehrtes Acme-Team"). Never "To whom it may concern", "Hi", "Hello".
- Then exactly one closing line per SIGNATURE RULES (the system appends the real signature).

SUBJECT LINE
- Short and specific, at most about 8 words: the target role or field plus the candidate's EXACT full name, separated by a comma or a pipe, no dashes. Examples: "Fullstack Developer | Jane Doe" or, for an unsolicited German application, "Initiativbewerbung Fullstack Developer, Jane Doe".
- Copy the candidate's full name character for character from the Candidate line. Never shorten, drop syllables or invent a nickname.
- Never vague: "Hello", "Hi", "Job application", "İş başvurusu", "Merhaba", "CV", "Application".
- Name a specific vacancy in the subject only if it appears verbatim in MATCHED OPEN ROLES; otherwise use the CV's primary field (for example Frontend or Fullstack).

ROLE CITATION — HARD RULES (critical failure if broken)
- Write "I am applying for [Title]" (or the equivalent) ONLY when [Title] appears verbatim in MATCHED OPEN ROLES.
- If MATCHED OPEN ROLES is empty (cold / initiative): do NOT name any vacancy from the site, careers page or research notes (sales, HR, auditor, Meister, Produktmanager, intern, …). Write for the CV's own field and never mention that no posting exists.
- Never force-fit the CV into an unrelated opening. Interest in a company is not a reason to apply for that company's wrong job.
- Target role or field: ONLY from MATCHED OPEN ROLES when non-empty; otherwise the candidate's PRIMARY CV discipline. Never "any position".
- Language: write entirely in the required language and match the formality of that culture.
`.trim();

/**
 * The "MATCHED OPEN ROLES" block. `jobs` empty → cold / initiative application.
 * `notes` is the JobFit explanation (context only, never a role to apply for).
 */
export function buildJobContext(
  jobs: JobFitResult["jobs"] | string,
  notes: string,
): string {
  const hasJobs = typeof jobs === "string" ? Boolean(jobs.trim()) : jobs.length > 0;
  const listing =
    typeof jobs === "string" ? jobs.trim() : JSON.stringify(jobs, null, 2);
  return hasJobs
    ? `MATCHED OPEN ROLES (you may name ONLY these titles as the role you apply for):\n${listing}\n\nJobFit notes (context only — do NOT apply to roles merely mentioned here as rejects):\n${notes || "—"}`
    : `MATCHED OPEN ROLES: (none)\nCold / initiative application only.\nInfer the target field from the CV's primary discipline (e.g. frontend/fullstack software engineering) — NOT from unmatched openings on the site.\nJobFit notes (rejects / no-match explanations — do NOT apply to those roles):\n${notes || "—"}`;
}

/** Research writer prompt — shared by the pipeline and tracker "write again". */
export function buildApplicationMailPrompt(a: {
  siteLanguage: string;
  fullName: string;
  email: string;
  companyName: string;
  url: string;
  recipient: string;
  jobContext: string;
  prefsBlock: string;
  cvText: string;
  researchMd: string;
  redoFeedback?: string;
}): string {
  return `You are an Application Writer specialist.
Write a personalized application email in language: ${a.siteLanguage} (match the website / company's working language).

Candidate: ${a.fullName} <${a.email}>
Company (TARGET from user URL ${a.url}): ${a.companyName}
Recipient hint: ${a.recipient}
Do not address or apply to a different company mentioned only in CV/site work history.
${a.jobContext}

Candidate job preferences (use notice period + work type when natural; do not dump salary):
${a.prefsBlock}

CV:
${a.cvText.slice(0, 7000)}

Company research:
${a.researchMd.slice(0, 4000)}

${a.redoFeedback ? `CRITICAL — address this reviewer feedback: ${a.redoFeedback}\n` : ""}

${MAIL_CRAFT_GUIDE}

${MAIL_FIELD_RULES}

Short, concrete, no fabricated experience. Follow MAIL CRAFT structure and length limits.`;
}

/** Rewrite of the original-language draft into the user's preferred language. */
export function buildMailTranslatePrompt(a: {
  preferredLang: string;
  draft: string;
  redoFeedback?: string;
}): string {
  return `Rewrite the email in preferred language code "${a.preferredLang}" (natural tone for that language).
Keep the same facts, structure, personalization, and length discipline as MAIL CRAFT.
Do not inflate length; do not add fabricated claims.

${OUTPUT_ONLY_RULES}

Source draft:
${a.draft}

${a.redoFeedback ? `Also fix: ${a.redoFeedback}\n` : ""}

${MAIL_CRAFT_GUIDE}

${MAIL_FIELD_RULES}`;
}
