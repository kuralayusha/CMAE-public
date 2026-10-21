"use client";

import { useT } from "@/components/I18nProvider";
import { MergeManager } from "@/components/MergeManager";
import { PageShell } from "@/components/ui";

export default function TrackerMergePage() {
  const t = useT();

  return (
    <PageShell
      title={t("tracker.merge.pageTitle")}
      subtitle={t("tracker.merge.pageSubtitle")}
    >
      <MergeManager />
    </PageShell>
  );
}
