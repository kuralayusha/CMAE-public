"use client";

export type SearchHistoryJob = {
  id: string;
  url: string;
  folderName: string;
  status: string;
  companyName?: string | null;
  createdAt?: number;
  displayName?: string;
};

const STATUS_META: Record<
  string,
  { label: string; tone: "run" | "done" | "cancel" | "err" | "idle" }
> = {
  queued: { label: "queued", tone: "run" },
  running: { label: "running", tone: "run" },
  done: { label: "done", tone: "done" },
  canceled: { label: "canceled", tone: "cancel" },
  error: { label: "error", tone: "err" },
};

type Props = {
  items: SearchHistoryJob[];
  panelIds: string[];
  selectedId: string | null;
  loading?: boolean;
  onSelect: (job: SearchHistoryJob) => void;
};

export function SearchHistory({
  items,
  panelIds,
  selectedId,
  loading = false,
  onSelect,
}: Props) {
  return (
    <aside className="cmae-hist" aria-label="Search history">
      <div className="cmae-hist-scroll">
        {loading && items.length === 0 ? (
          <div className="cmae-hist-empty" role="status">
            <span className="cmae-hist-empty-mark" aria-hidden />
            <p>Loading…</p>
          </div>
        ) : items.length === 0 ? (
          <div className="cmae-hist-empty">
            <span className="cmae-hist-empty-mark" aria-hidden />
            <p>No searches yet</p>
            <span className="cmae-hist-empty-hint">
              When you start with a new URL, it will appear here.
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
              );
              const meta = STATUS_META[job.status] || {
                label: job.status,
                tone: "idle" as const,
              };
              const inPanel = panelIds.includes(job.id);
              const selected = selectedId === job.id;

              return (
                <li key={job.id}>
                  <button
                    type="button"
                    className={[
                      "cmae-hist-row",
                      `tone-${meta.tone}`,
                      inPanel ? "is-open" : "",
                      selected ? "is-selected" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => onSelect(job)}
                    title={job.url}
                    aria-current={selected ? "true" : undefined}
                    aria-pressed={inPanel}
                  >
                    <span
                      className={`cmae-hist-dot tone-${meta.tone}`}
                      aria-hidden
                    />
                    <span className="cmae-hist-body">
                      <span className="cmae-hist-name">{name}</span>
                      <span className="cmae-hist-meta">
                        <span className={`cmae-hist-badge tone-${meta.tone}`}>
                          {meta.label}
                        </span>
                        {inPanel ? (
                          <span className="cmae-hist-open">open</span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

function cleanName(raw: string) {
  return (
    raw
      .replace(/\s*\(canceled\)\s*$/i, "")
      .replace(/^\d+\s*-\s*/, "")
      .trim() || raw
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
