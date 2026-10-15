import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Always land on Tracker; RequireOnboarded sends incomplete installs to onboarding. */
export default function HomePage() {
  redirect("/tracker");
}
