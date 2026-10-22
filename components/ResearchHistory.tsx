"use client";

import { HoverTip } from "@/components/HoverTip";
import { useLocaleUpper, useT } from "@/components/I18nProvider";

export type ResearchHistoryJob = {
  id: string;
  url: string;
  folderName: string;
  status: string;
  companyName?: string | null;
  createdAt?: number;
  displayName?: string;
};

const STATUS_TONE: Record<
  string,
  "run" | "done" | "cancel" | "err" | "idle"
> = {
  queued: "run",
  running: "run",
  done: "done",
  canceled: "cancel",
  error: "err",
};

type Props = {
  items: ResearchHistoryJob[];
  panelIds: string[];
  selectedId: string | null;
  loading?: boolean;
  onSelect: (job: ResearchHistoryJob) => void;
};

export function ResearchHistory({
  items,
  panelIds,
  selectedId,
  loading = false,
  onSelect,
}: Props) {
  const t = useT();
  const upper = useLocaleUpper();
  const statusSuffixes = [
    t("folders.suffixCanceled"),
    t("folders.suffixError"),
  ];
  return (
    <aside className="cmae-hist" aria-label={t("research.historyAria")}>
      <header className="cmae-hist-head">
        <h2>{t("research.historyTitle")}</h2>
      </header>
      <div className="cmae-hist-scroll">
        {loading && items.length === 0 ? (
          <div className="cmae-hist-empty" role="status">
            <p>{t("common.loading")}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="cmae-hist-empty">
            <p>{t("research.historyEmpty")}</p>
            <span className="cmae-hist-empty-hint">
              {t("research.historyEmptyHint")}
            </span>
          </div>
        ) : (
          <ul className="cmae-hist-list" role="list">
            {items.map((job) => {
              const name = cleanName(
                job.displayName ||
                  job.companyName ||
                  job.folderName ||
                  hostOf(job.url),
                statusSuffixes,
              );
              const tone = STATUS_TONE[job.status] || "idle";
              const statusKey = `terminal.status.${job.status}`;
              const statusLabel = t(statusKey);
              const label = upper(
                statusLabel === statusKey ? job.status : statusLabel,
              );
              const inPanel = panelIds.includes(job.id);
              const selected = selectedId === job.id;

              return (
                <li key={job.id}>
                  <HoverTip label={job.url} className="is-fill">
                    <button
                      type="button"
                      className={[
                        "cmae-hist-row",
                        `tone-${tone}`,
                        inPanel ? "is-open" : "",
                        selected ? "is-selected" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => onSelect(job)}
                      aria-current={selected ? "true" : undefined}
                      aria-pressed={inPanel}
                    >
                      <span
                        className={`cmae-hist-dot tone-${tone}`}
                        aria-hidden
                      />
                      <span className="cmae-hist-body">
                        <span className="cmae-hist-name">{name}</span>
                        <span className="cmae-hist-meta">
                          <span className={`cmae-hist-badge tone-${tone}`}>
                            {label}
                          </span>
                          {inPanel ? (
                            <span className="cmae-hist-open">
                              {upper(t("research.inPanel"))}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  </HoverTip>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

function cleanName(raw: string, statusSuffixes: string[] = []) {
  let out = String(raw || "").trim();
  const needles = [...statusSuffixes, "(canceled)", "(error)"];
  for (const s of needles) {
    const needle = s.trim();
    if (!needle) continue;
    if (out.toLowerCase().endsWith(needle.toLowerCase())) {
      out = out.slice(0, out.length - needle.length).trim();
      break;
    }
  }
  return out.replace(/^\d+\s*-\s*/, "").trim() || raw;
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
