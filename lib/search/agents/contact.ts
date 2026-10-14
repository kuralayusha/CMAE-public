import { extractEmails, rankEmailsWithAi } from "../discover";
import type { RunContext } from "../context";
import { speak } from "../speak";
import { writeFile } from "../workspace";

export async function runContact(ctx: RunContext) {
  const { jobId } = ctx;
  speak(jobId, "contact", "system", "── contact online · hiring e-posta avı");

  if (ctx.redoFeedback.contact) {
    speak(jobId, "contact", "think", `Reviewer feedback: ${ctx.redoFeedback.contact}`);
  }

  const roleByUrl = new Map(
    ctx.routes.map((r) => [r.href.replace(/\/$/, ""), r.role] as const),
  );

  const hits: { email: string; page: string; pageRole?: string }[] = [];
  for (const p of ctx.pages) {
    const found = await extractEmails(jobId, `${p.title}\n${p.text}`, p.url);
    const pageRole = roleByUrl.get(p.url.replace(/\/$/, ""));
    for (const email of found) {
      hits.push({ email, page: p.url, pageRole });
    }
  }

  const ranked = await rankEmailsWithAi(jobId, ctx.companyName || "Company", hits);
  ctx.emails = [
    ...new Map(ranked.map((e) => [e.email.toLowerCase(), e])).values(),
  ].sort((a, b) => a.priority - b.priority);
  ctx.primaryEmail = ctx.emails[0]?.email || null;

  await writeFile(
    ctx.folderPath,
    "iletisim.md",
    `# İletişim (contact agent)\n\n## Önerilen\n${
      ctx.primaryEmail || "_bulunamadı_"
    }\n\n## Adaylar\n${
      ctx.emails.length
        ? ctx.emails
            .map(
              (e) =>
                `- ${e.email} _(role: ${e.role}, p${e.priority}, ${e.page})_ — ${e.reason}`,
            )
            .join("\n")
        : "- (yok)"
    }\n${
      ctx.redoFeedback.contact
        ? `\n## Reviewer notu\n${ctx.redoFeedback.contact}\n`
        : ""
    }`,
  );

  speak(
    jobId,
    "contact",
    ctx.primaryEmail ? "ok" : "think",
    ctx.primaryEmail
      ? `önerilen: ${ctx.primaryEmail}`
      : "direkt e-posta yok — writer genel hitap kullanacak",
  );
}
