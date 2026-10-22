import { t } from "@/lib/i18n/t";
import { sameLanguage } from "@/lib/mail/lang";
import { stripLeadingMarkdownH1 } from "@/lib/mail/subject-body";
import { WS } from "@/lib/workspace/filenames";
import { throwIfCanceled } from "../cancel";
import {
  extractEmailsFromText,
  planExternalQueriesWithAi,
  type RankedEmail,
} from "../discover";
import type { RunContext } from "../context";
import { askLlm } from "../llm";
import { runCurl } from "../shell";
import { speak } from "../speak";
import { writeFile } from "../workspace";
import { formatContactMarkdown } from "./contact";

/** No agent chatter — files must contain only the deliverable. */
export const OUTPUT_ONLY_RULES = `
OUTPUT RULES (mandatory):
- Output ONLY the requested deliverable. Start with the first required section or field.
- Do NOT write preambles, meta commentary, process notes, or apologies (e.g. "Here is the English text…", "İstediğiniz yapıya uygun metin aşağıda", "As requested…", "Aşağıda çeviri…").
- Do NOT narrate what you are about to do. No "Sure,", "Of course,", or similar.
- The user wants salt facts / salt work product — nothing else.
`.trim();

const RESEARCH_STRUCTURE_RULES = `
STRUCTURE RULES (mandatory):
- Do NOT write a top-level # title or company-name heading — the system already prepends the file title.
- Start directly with ## Summary (translate section headings into the target language).
- Use ## for section headings only. Never duplicate the company name as an H1.
- Do not add a horizontal-rule-only intro; begin with the first ## section.

EMAIL RULES:
- If you find an address obfuscated for spam (name(at)domain, name[at]domain, name at domain, [dot]), write it as a normal email with @ and . (e.g. kontakt@example-computer.de). Never leave (at)/[at] forms in the note.
`.trim();

/** Drop LLM chatter before the first ## section. */
function stripLeadingMetaBeforeSections(md: string): string {
  const lines = String(md || "").replace(/^\uFEFF/, "").split("\n");
  const first = lines.findIndex((l) => /^##\s+\S/.test(l.trim()));
  if (first <= 0) return md.trim();
  return lines.slice(first).join("\n").trim();
}

/** Pull normalized emails from research notes into contact.md / ctx.emails. */
async function harvestEmailsFromResearchNotes(
  ctx: RunContext,
  notes: string[],
): Promise<void> {
  const existing = new Set(ctx.emails.map((e) => e.email.toLowerCase()));
  const found = new Set<string>();
  for (const note of notes) {
    for (const email of extractEmailsFromText(note)) {
      if (!existing.has(email)) found.add(email);
    }
  }
  if (!found.size) return;

  let priority = (ctx.emails.at(-1)?.priority ?? 0) + 1;
  const reason = t("research.contactHarvestedFromNote");
  const added: RankedEmail[] = [];
  for (const email of found) {
    added.push({
      email,
      page: "research note",
      role: "contact",
      priority: priority++,
      reason,
    });
  }
  ctx.emails = [...ctx.emails, ...added].sort((a, b) => a.priority - b.priority);
  if (!ctx.primaryEmail) {
    ctx.primaryEmail = ctx.emails[0]?.email || null;
  }
  await writeFile(ctx.folderPath, "contact.md", formatContactMarkdown(ctx));
  speak(
    ctx.jobId,
    "research",
    "ok",
    t("terminal.detail.contactHarvested", {
      count: added.length,
      emails: added.map((e) => e.email).join(", "),
    }),
    t("terminal.plain.contactHarvested", { count: added.length }),
  );
}

export async function runResearch(ctx: RunContext) {
  const { jobId, user } = ctx;
  speak(
    jobId,
    "research",
    "system",
    t("terminal.detail.researchOnline"),
    t("terminal.plain.startedTask"),
  );
  throwIfCanceled(jobId);

  if (ctx.redoFeedback.research) {
    speak(
      jobId,
      "research",
      "think",
      t("terminal.detail.reviewerFeedback", { msg: ctx.redoFeedback.research }),
    );
  }

  const queries = await planExternalQueriesWithAi(
    jobId,
    ctx.companyName,
    ctx.siteLanguage,
    ctx.url,
  );
  throwIfCanceled(jobId);

  let externalSnippet = "";
  for (const q of queries) {
    throwIfCanceled(jobId);
    speak(
      jobId,
      "research",
      "think",
      t("terminal.detail.query", { query: q }),
      t("terminal.plain.gatheringInfo"),
    );
    const ddg = `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const { stdout } = await runCurl(jobId, [
      "-sL",
      "--max-time",
      "25",
      "-A",
      "Mozilla/5.0 (compatible; CMAEBot/1.0)",
      ddg,
    ]);
    externalSnippet +=
      "\n" +
      stdout
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, 3500);
  }

  const siteLang = ctx.siteLanguage || "en";
  const researchRaw = await askLlm(
    jobId,
    "research.research",
    `You are a Company Research specialist. Markdown research note. No fabricated metrics.

CRITICAL LANGUAGE RULE: Write the ENTIRE note in language code "${siteLang}" (the company website language). Do not use any other language for headings or body text.

${OUTPUT_ONLY_RULES}

${RESEARCH_STRUCTURE_RULES}

TARGET LOCK: The user-given URL is the only research/application target.
Company: ${ctx.companyName}
Site: ${ctx.url}

You may use external snippets only to enrich facts about THIS same entity. Never switch the subject to another company (e.g. an employer listed on a personal portfolio). If the site is a personal/candidate portfolio, profile that person/brand — not their past employers.

Site excerpt:
${(ctx.home?.text || "").slice(0, 5000)}

External snippets:
${externalSnippet.slice(0, 7000)}

${ctx.redoFeedback.research ? `Reviewer feedback to address: ${ctx.redoFeedback.research}\n` : ""}

Required sections (## headings, in this order — translate heading text into "${siteLang}"):
## Summary
## Focus areas / products
## Culture & location
## Notes for the candidate
## Sources
`,
    t("terminal.llm.writingProfile"),
    "research",
  );

  const research = stripLeadingMetaBeforeSections(
    stripLeadingMarkdownH1(researchRaw),
  );
  ctx.researchMd = research;
  await writeFile(
    ctx.folderPath,
    WS.companyInfo,
    `# ${t("workspaceFiles.companyInfoTitle", {
      company: ctx.companyName,
      lang: siteLang,
    })}\n\n${research}\n`,
  );

  const sameLang = sameLanguage(siteLang, user.preferredLang);
  const notesForHarvest = [research];
  if (!sameLang) {
    const translatedRaw = await askLlm(
      jobId,
      "research.research",
      `Rewrite this company research note in preferred language code "${user.preferredLang}" (natural tone for that language).
Keep the same facts, structure, and section headings (translate headings). Do not invent metrics or claims.

${OUTPUT_ONLY_RULES}

${RESEARCH_STRUCTURE_RULES}

Source note:
${research}
`,
      t("terminal.llm.profileLang", { lang: user.preferredLang }),
      "research",
    );
    const translated = stripLeadingMetaBeforeSections(
      stripLeadingMarkdownH1(translatedRaw),
    );
    notesForHarvest.push(translated);
    await writeFile(
      ctx.folderPath,
      WS.companyInfoTranslated,
      `# ${t("workspaceFiles.companyInfoTranslatedTitle", {
        company: ctx.companyName,
        lang: user.preferredLang,
      })}\n\n${translated}\n`,
    );
    const files = `${WS.companyInfo} + ${WS.companyInfoTranslated}`;
    speak(
      jobId,
      "research",
      "ok",
      t("terminal.detail.filesWritten", { files }),
      t("terminal.plain.filesWritten", { files }),
    );
  } else {
    speak(
      jobId,
      "research",
      "ok",
      t("terminal.detail.filesWritten", { files: WS.companyInfo }),
      t("terminal.plain.filesWritten", { files: WS.companyInfo }),
    );
  }

  await harvestEmailsFromResearchNotes(ctx, notesForHarvest);
}
