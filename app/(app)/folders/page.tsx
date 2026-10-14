"use client";

import { Suspense } from "react";
import { FolderBrowser } from "@/components/FolderBrowser";
import { PageHelpModal, usePageHelp } from "@/components/PageHelp";
import { TopNav } from "@/components/TopNav";
import { PageShell } from "@/components/ui";
import { PAGE_HELP } from "@/lib/help/pages";

const meta = PAGE_HELP.folders;

export default function FoldersPage() {
  const help = usePageHelp("folders");

  return (
    <>
      <TopNav active="folders" onHelp={help.reopen} />
      <div className="cmae-shell--finder">
        <PageShell title={meta.title} subtitle={meta.subtitle}>
          <Suspense fallback={<p className="cmae-fb-loading">Klasörler yükleniyor…</p>}>
            <FolderBrowser />
          </Suspense>
        </PageShell>
      </div>
      <PageHelpModal
        pageId="folders"
        open={help.open}
        onClose={help.close}
      />
    </>
  );
}
