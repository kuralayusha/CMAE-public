"use client";

import { Suspense } from "react";
import { FolderBrowser } from "@/components/FolderBrowser";
import { useT } from "@/components/I18nProvider";
import { PageHelpModal, usePageHelp } from "@/components/PageHelp";
import { TopNav } from "@/components/TopNav";
import { PageShell } from "@/components/ui";

export default function FoldersPage() {
  const t = useT();
  const help = usePageHelp("folders");

  return (
    <>
      <TopNav active="folders" onHelp={help.reopen} />
      <PageShell
        title={t("help.folders.title")}
        subtitle={t("help.folders.subtitle")}
      >
        <Suspense
          fallback={
            <p className="cmae-fb-loading">{t("common.loading")}</p>
          }
        >
          <FolderBrowser />
        </Suspense>
      </PageShell>
      <PageHelpModal
        pageId="folders"
        open={help.open}
        onClose={help.close}
      />
    </>
  );
}
