import { t } from "@/lib/i18n/t";
import { sameLanguage } from "@/lib/mail/lang";
import { WS } from "@/lib/workspace/filenames";
import { planExternalQueriesWithAi } from "../discover";
import type { RunContext } from "../context";
import { askLlm } from "../llm";
import { runCurl } from "../shell";
import { speak } from "../speak";
import { writeFile } from "../workspace";

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
  const research = await askLlm(
    jobId,
    `You are a Company Research specialist. Markdown research note. No fabricated metrics.

CRITICAL LANGUAGE RULE: Write the ENTIRE note in language code "${siteLang}" (the company website language). Do not use any other language for headings or body text.

Company: ${ctx.companyName}
Site: ${ctx.url}
Site excerpt:
${(ctx.home?.text || "").slice(0, 5000)}

External snippets:
${externalSnippet.slice(0, 7000)}

${ctx.redoFeedback.research ? `Reviewer feedback to address: ${ctx.redoFeedback.research}\n` : ""}

## Summary
## Focus areas / products
## Culture & location
## Notes for the candidate
## Sources
`,
    "Writing company profile…",
    "research",
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
  if (!sameLang) {
    const translated = await askLlm(
      jobId,
      `Rewrite this company research note in preferred language code "${user.preferredLang}" (natural tone for that language).
Keep the same facts, structure, and section headings (translate headings). Do not invent metrics or claims.

Source note:
${research}
`,
      `Company profile (${user.preferredLang})…`,
      "research",
    );
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
