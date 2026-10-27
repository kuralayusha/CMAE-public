import { notFound } from "next/navigation";
import { OnboardingWizard } from "@/components/OnboardingWizard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Visual walkthrough of the onboarding steps. Writes nothing (see the wizard's
 * `preview` prop) and only exists in development builds.
 */
export default function OnboardingPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <OnboardingWizard preview />;
}
