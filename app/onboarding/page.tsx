import { redirect } from "next/navigation";
import { OnboardingWizard } from "@/components/OnboardingWizard";
import { isOnboardingComplete } from "@/lib/onboarding/status";

export default function OnboardingPage() {
  if (isOnboardingComplete()) {
    redirect("/tracker");
  }
  return <OnboardingWizard />;
}
