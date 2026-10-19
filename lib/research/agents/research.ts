import { t } from "@/lib/i18n/t";
import { sameLanguage } from "@/lib/mail/lang";
import { stripLeadingMarkdownH1 } from "@/lib/mail/subject-body";
import { WS } from "@/lib/workspace/filenames";
import { planExternalQueriesWithAi } from "../discover";
import type { RunContext } from "../context";
import { askLlm } from "../llm";
import { runCurl } from "../shell";
import { speak } from "../speak";
import { writeFile } from "../workspace";

const RESEARCH_STRUCTURE_RULES = `
STRUCTURE RULES (mandatory):
- Do NOT write a top-level # title or company-name heading — the system already prepends the file title.
- Start directly with ## Summary (translate section headings into the target language).
- Use ## for section headings only. Never duplicate the company name as an H1.
- Do not add a horizontal-rule-only intro; begin with the first ## section.
`.trim();

export async function runResearch(ctx: RunContext) {
  const { jobId, user } = ctx;
  speak(jobId, "research", "system", "── research online · company profile");

  if (ctx.redoFeedback.research) {
    speak(jobId, "research", "think", `Reviewer feedback: ${ctx.redoFeedback.research}`);
  }

  const queries = await planExternalQueriesWithAi(
    jobId,
    ctx.companyName,
    ctx.siteLanguage,
    ctx.url,
  );

  let externalSnippet = "";
  for (const q of queries) {
    speak(jobId, "research", "think", `Query: ${q}`);
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
    `You are a Company Research specialist. Markdown research note. No fabricated metrics.

CRITICAL LANGUAGE RULE: Write the ENTIRE note in language code "${siteLang}" (the company website language). Do not use any other language for headings or body text.

${RESEARCH_STRUCTURE_RULES}

Company: ${ctx.companyName}
Site: ${ctx.url}
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
    "Writing company profile…",
    "research",
  );

  const research = stripLeadingMarkdownH1(researchRaw);
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
  if (!sameLang) {
    const translatedRaw = await askLlm(
      jobId,
      `Rewrite this company research note in preferred language code "${user.preferredLang}" (natural tone for that language).
Keep the same facts, structure, and section headings (translate headings). Do not invent metrics or claims.

${RESEARCH_STRUCTURE_RULES}

Source note:
${research}
`,
      `Company profile (${user.preferredLang})…`,
      "research",
    );
    const translated = stripLeadingMarkdownH1(translatedRaw);
    await writeFile(
      ctx.folderPath,
      WS.companyInfoTranslated,
      `# ${t("workspaceFiles.companyInfoTranslatedTitle", {
        company: ctx.companyName,
        lang: user.preferredLang,
      })}\n\n${translated}\n`,
    );
    speak(
      jobId,
      "research",
      "ok",
      `${WS.companyInfo} + ${WS.companyInfoTranslated} written`,
    );
  } else {
    speak(jobId, "research", "ok", `${WS.companyInfo} written`);
  }
}
