import { t } from "@/lib/i18n/t";
import { throwIfCanceled } from "../cancel";
import { extractEmails, rankEmailsWithAi } from "../discover";
import type { RunContext } from "../context";
import { speak } from "../speak";
import { writeFile } from "../workspace";

/** contact.md body — also rewritten after research harvests new addresses. */
export function formatContactMarkdown(ctx: RunContext): string {
  return `# Contact (contact agent)\n\n## Recommended\n${
    ctx.primaryEmail || "_not found_"
  }\n\n## Candidates\n${
    ctx.emails.length
      ? ctx.emails
          .map(
            (e) =>
              `- ${e.email} _(role: ${e.role}, p${e.priority}, ${e.page})_ — ${e.reason}`,
          )
          .join("\n")
      : "- (none)"
  }\n${
    ctx.redoFeedback.contact
      ? `\n## Reviewer note\n${ctx.redoFeedback.contact}\n`
      : ""
  }`;
}

export async function runContact(ctx: RunContext) {
  const { jobId } = ctx;
  speak(
    jobId,
    "contact",
    "system",
    t("terminal.detail.contactOnline"),
    t("terminal.plain.startedTask"),
  );
  throwIfCanceled(jobId);

  if (ctx.redoFeedback.contact) {
    speak(
      jobId,
      "contact",
      "think",
      t("terminal.detail.reviewerFeedback", { msg: ctx.redoFeedback.contact }),
    );
  }

  const roleByUrl = new Map(
    ctx.routes.map((r) => [r.href.replace(/\/$/, ""), r.role] as const),
  );

  const hits: { email: string; page: string; pageRole?: string }[] = [];
  for (const p of ctx.pages) {
    throwIfCanceled(jobId);
    const found = await extractEmails(jobId, `${p.title}\n${p.text}`, p.url);
    const pageRole = roleByUrl.get(p.url.replace(/\/$/, ""));
    for (const email of found) {
      hits.push({ email, page: p.url, pageRole });
    }
  }

  const ranked = await rankEmailsWithAi(
    jobId,
    ctx.companyName || "Company",
    hits,
    ctx.url,
    ctx.user.preferredLang || "en",
  );
  ctx.emails = [
    ...new Map(ranked.map((e) => [e.email.toLowerCase(), e])).values(),
  ].sort((a, b) => a.priority - b.priority);
  ctx.primaryEmail = ctx.emails[0]?.email || null;

  await writeFile(ctx.folderPath, "contact.md", formatContactMarkdown(ctx));

  speak(
    jobId,
    "contact",
    ctx.primaryEmail ? "ok" : "think",
    ctx.primaryEmail
      ? t("terminal.detail.recommendedEmail", { email: ctx.primaryEmail })
      : t("terminal.detail.noDirectEmail"),
    ctx.primaryEmail
      ? t("terminal.plain.recommendedEmail", { email: ctx.primaryEmail })
      : t("terminal.plain.noDirectEmail"),
  );
}
