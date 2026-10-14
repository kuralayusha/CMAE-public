"use client";

import { PageHelpModal, usePageHelp } from "@/components/PageHelp";
import { TrackerList } from "@/components/TrackerList";
import { TopNav } from "@/components/TopNav";
import { PageShell } from "@/components/ui";
import { PAGE_HELP } from "@/lib/help/pages";

const meta = PAGE_HELP.tracker;

export default function TrackerPage() {
  const help = usePageHelp("tracker");

  return (
    <>
      <TopNav active="tracker" onHelp={help.reopen} />
      <PageShell title={meta.title} subtitle={meta.subtitle}>
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
