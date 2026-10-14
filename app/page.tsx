import { redirect } from "next/navigation";
import { isOnboardingComplete } from "@/lib/onboarding/status";

export default function HomePage() {
  if (!isOnboardingComplete()) {
    redirect("/onboarding");
  }
  redirect("/tracker");
}
