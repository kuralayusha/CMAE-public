import { redirect } from "next/navigation";
import { isOnboardingComplete } from "@/lib/onboarding/status";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  if (!isOnboardingComplete()) {
    redirect("/onboarding");
  }
  return children;
}
