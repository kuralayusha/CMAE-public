"use client";

import { useT } from "@/components/I18nProvider";
import { TrackerList } from "@/components/TrackerList";
import { PageShell } from "@/components/ui";

export default function TrackerPage() {
  const t = useT();

  return (
    <PageShell
      title={t("help.tracker.title")}
      subtitle={t("help.tracker.subtitle")}
      helpPageId="tracker"
    >
      <TrackerList />
    </PageShell>
  );
}
