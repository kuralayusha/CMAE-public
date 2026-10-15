"use client";

import { useT } from "@/components/I18nProvider";
import { PageHelpModal, usePageHelp } from "@/components/PageHelp";
import { TrackerList } from "@/components/TrackerList";
import { TopNav } from "@/components/TopNav";
import { PageShell } from "@/components/ui";

export default function TrackerPage() {
  const t = useT();
  const help = usePageHelp("tracker");

  return (
    <>
      <TopNav active="tracker" onHelp={help.reopen} />
      <PageShell
        title={t("help.tracker.title")}
        subtitle={t("help.tracker.subtitle")}
      >
        <TrackerList />
      </PageShell>
      <PageHelpModal
        pageId="tracker"
        open={help.open}
        onClose={help.close}
      />
    </>
  );
}
