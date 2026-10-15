import { redirect } from "next/navigation";
import { isOnboardingComplete } from "@/lib/onboarding/status";

export const dynamic = "force-dynamic";

export default function HomePage() {
  if (!isOnboardingComplete()) {
    redirect("/onboarding");
  }
  redirect("/tracker");
}
