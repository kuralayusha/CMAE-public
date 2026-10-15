import { OnboardingWizard } from "@/components/OnboardingWizard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * No server-side DB gate here — RSC and API can disagree on SQLite path after
 * wipe/desktop. The wizard client-checks /api/onboarding/status and routes
 * to Tracker when the same API that ran `complete` says the flag is set.
 */
export default function OnboardingPage() {
  return <OnboardingWizard />;
}
