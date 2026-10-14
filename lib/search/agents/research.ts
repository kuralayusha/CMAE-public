import { planExternalQueriesWithAi } from "../discover";
import type { RunContext } from "../context";
import { askLlm } from "../llm";
import { runCurl } from "../shell";
import { speak } from "../speak";
import { writeFile } from "../workspace";

export async function runResearch(ctx: RunContext) {
  const { jobId } = ctx;
  speak(jobId, "research", "system", "── research online · şirket kesiti");

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
    speak(jobId, "research", "think", `Sorgu: ${q}`);
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

  const research = await askLlm(
    jobId,
    `You are a Company Research specialist. Markdown research note. No fabricated metrics.

Company: ${ctx.companyName}
Site: ${ctx.url}
Site excerpt:
${(ctx.home?.text || "").slice(0, 5000)}

External snippets:
${externalSnippet.slice(0, 7000)}

${ctx.redoFeedback.research ? `Reviewer feedback to address: ${ctx.redoFeedback.research}\n` : ""}

## Özet
## Çalışma alanları / ürünler
## Kültür & konum
## Aday için notlar
## Kaynaklar
`,
    "Şirket profili yazılıyor…",
    "research",
  );

  ctx.researchMd = research;
  await writeFile(ctx.folderPath, "sirket_bilgileri.md", research);
  speak(jobId, "research", "ok", "sirket_bilgileri.md yazıldı");
}
