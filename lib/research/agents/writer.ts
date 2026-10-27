import { t } from "@/lib/i18n/t";
import { sameLanguage } from "@/lib/mail/lang";
import { applySignatureToMailDraft } from "@/lib/mail/signature";
import { formatPreferencesForApplication } from "@/lib/settings/preferences";
import { getJobPreferences, getSettingsRow } from "@/lib/settings/service";
import { throwIfCanceled } from "../cancel";
import type { RunContext } from "../context";
import { askLlm } from "../llm";
import {
  buildApplicationMailPrompt,
  buildJobContext,
  buildMailTranslatePrompt,
  canonicalizeMailDraft,
} from "./application-mail";
import { speak } from "../speak";
import { writeFile } from "../workspace";

export async function runWriter(ctx: RunContext) {
  const { jobId, user } = ctx;
  speak(
    jobId,
    "writer",
    "system",
    t("terminal.detail.writerOnline"),
    t("terminal.plain.startedTask"),
  );
  throwIfCanceled(jobId);

  if (ctx.redoFeedback.writer) {
    speak(
      jobId,
      "writer",
      "think",
      t("terminal.detail.reviewerFeedback", { msg: ctx.redoFeedback.writer }),
    );
  }

  const matchedJobs =
    ctx.jobFit?.hasMatchingJob && ctx.jobFit.jobs.length
      ? ctx.jobFit.jobs
      : [];
  const jobContext = buildJobContext(matchedJobs, ctx.jobFit?.notes || "");

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
    "research.writer",
    buildApplicationMailPrompt({
      siteLanguage: ctx.siteLanguage,
      fullName: user.fullName,
      email: user.email,
      companyName: ctx.companyName,
      url: ctx.url,
      recipient,
      jobContext,
      prefsBlock,
      cvText: user.cvText,
      researchMd: ctx.researchMd,
      redoFeedback: ctx.redoFeedback.writer,
    }),
    t("terminal.llm.mailDraft", { lang: ctx.siteLanguage }),
    "writer",
  );

  const sameLang = sameLanguage(ctx.siteLanguage, user.preferredLang);
  const signature = getSettingsRow()?.emailSignature ?? null;
  ctx.draftSite = canonicalizeMailDraft(
    applySignatureToMailDraft(ctx.draftSite, signature),
    user.fullName,
  );

  // Same language → no translate LLM call, no email_translated.md
  if (sameLang) {
    ctx.draftPreferred = ctx.draftSite;
  } else {
    ctx.draftPreferred = await askLlm(
      jobId,
      "research.writer",
      buildMailTranslatePrompt({
        preferredLang: user.preferredLang,
        draft: ctx.draftSite,
        redoFeedback: ctx.redoFeedback.writer,
      }),
      t("terminal.llm.mailLang", { lang: user.preferredLang }),
      "writer",
    );
    ctx.draftPreferred = canonicalizeMailDraft(
      applySignatureToMailDraft(ctx.draftPreferred, signature),
      user.fullName,
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
      ? t("terminal.detail.draftOriginalOnly")
      : t("terminal.detail.draftBoth"),
    sameLang
      ? t("terminal.plain.draftOriginalOnly")
      : t("terminal.plain.draftBoth"),
  );
}
