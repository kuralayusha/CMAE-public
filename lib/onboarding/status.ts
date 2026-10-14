import { listCvs } from "@/lib/cv/library";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { parseJobPreferences } from "@/lib/settings/preferences";
import { eq } from "drizzle-orm";

export type OnboardingGaps = string[];

function filled(v: string | null | undefined): boolean {
  return Boolean(v && String(v).trim());
}

/** Required fields for a finished onboarding — flag alone is not enough. */
export function getOnboardingGaps(): OnboardingGaps {
  getDb(); // ensure schema exists
  const row = getDb().select().from(settings).where(eq(settings.id, 1)).get();
  const gaps: string[] = [];

  if (!filled(row?.fullName)) gaps.push("fullName");
  if (!filled(row?.gmailAddress)) gaps.push("gmailAddress");
  if (!filled(row?.gmailAppPasswordEnc)) gaps.push("gmailAppPassword");
  if (!filled(row?.cursorApiKeyEnc) && !filled(process.env.CURSOR_API_KEY)) {
    gaps.push("cursorApiKey");
  }
  if (!filled(row?.emailSignature)) gaps.push("emailSignature");
  if (!filled(row?.preferredLanguage)) gaps.push("preferredLanguage");
  if (!(row?.followUpDays != null && row.followUpDays >= 1)) {
    gaps.push("followUpDays");
  }

  const prefs = parseJobPreferences(row?.jobPreferencesJson);
  if (!prefs.workTypes.length) gaps.push("workTypes");
  if (prefs.noticeWeeks == null || prefs.noticeWeeks < 0) gaps.push("noticeWeeks");
  if (prefs.salaryMin == null || prefs.salaryMin < 0) gaps.push("salaryMin");
  if (!prefs.salaryPeriod) gaps.push("salaryPeriod");
  if (!prefs.salaryKind) gaps.push("salaryKind");
  if (!prefs.salaryCurrency) gaps.push("salaryCurrency");
  if (
    prefs.salaryCurrency === "other" &&
    !filled(prefs.salaryCurrencyOther)
  ) {
    gaps.push("salaryCurrencyOther");
  }

  let cvOk = false;
  try {
    cvOk = listCvs().length >= 1 || Boolean(row?.cvText?.trim());
  } catch {
    cvOk = Boolean(row?.cvText?.trim());
  }
  if (!cvOk) gaps.push("cv");

  return gaps;
}

export function isOnboardingFlagSet(): boolean {
  const row = getDb().select().from(settings).where(eq(settings.id, 1)).get();
  return filled(row?.onboardingCompletedAt);
}

/** Complete only when flag is set AND all required fields are present. */
export function isOnboardingComplete(): boolean {
  if (!isOnboardingFlagSet()) return false;
  return getOnboardingGaps().length === 0;
}

export function assertOnboarded(): void {
  if (!isOnboardingComplete()) {
    throw new OnboardingRequiredError();
  }
}

export class OnboardingRequiredError extends Error {
  status = 403;
  constructor() {
    super("This action requires completed onboarding");
    this.name = "OnboardingRequiredError";
  }
}

export function markOnboardingComplete(): string {
  const at = new Date().toISOString();
  getDb()
    .update(settings)
    .set({
      onboardingCompletedAt: at,
      updatedAt: at,
    })
    .where(eq(settings.id, 1))
    .run();
  return at;
}
