"use client";

import { Suspense, useEffect, useState } from "react";
import { FolderBrowser } from "@/components/FolderBrowser";
import { useT } from "@/components/I18nProvider";
import { PageShell } from "@/components/ui";
import {
  detectFileManagerKind,
  type FileManagerKind,
} from "@/lib/platform/file-manager";

function fileManagerLabelKey(kind: FileManagerKind): string {
  if (kind === "finder") return "folders.fileManagerFinder";
  if (kind === "explorer") return "folders.fileManagerExplorer";
  return "folders.fileManagerFiles";
}

export default function FoldersPage() {
  const t = useT();
  const [fmKind, setFmKind] = useState<FileManagerKind>("files");

  useEffect(() => {
    setFmKind(detectFileManagerKind());
  }, []);

  return (
    <PageShell
      title={t("help.folders.title")}
      subtitle={t("help.folders.subtitle", {
        fileManager: t(fileManagerLabelKey(fmKind)),
      })}
      helpPageId="folders"
    >
      <Suspense
        fallback={
          <p className="cmae-fb-loading">{t("common.loading")}</p>
        }
      >
        <FolderBrowser />
      </Suspense>
    </PageShell>
  );
}
