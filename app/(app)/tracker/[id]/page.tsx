"use client";

import { useParams } from "next/navigation";
import { useT } from "@/components/I18nProvider";
import { TrackerDetail } from "@/components/TrackerDetail";
import { TopNav } from "@/components/TopNav";
import { PageShell } from "@/components/ui";

export default function TrackerDetailPage() {
  const t = useT();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);

  return (
    <>
      <TopNav active="tracker" />
      <PageShell
        title={t("tracker.detailPage.title")}
        subtitle={t("tracker.detailPage.subtitle")}
      >
        {Number.isFinite(id) ? (
          <TrackerDetail itemId={id} />
        ) : (
          <p>{t("tracker.detailPage.notFound")}</p>
        )}
      </PageShell>
    </>
  );
}
