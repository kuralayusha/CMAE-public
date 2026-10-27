"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useT } from "@/components/I18nProvider";
import { Button, PageShell } from "@/components/ui";
import type { TVars } from "@/lib/i18n/lookup";

type UserCard = {
  user_id: string;
  runs: number;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  saved_usd: number;
  first_event_at: string | null;
  last_event_at: string | null;
  first_seen: string | null;
  last_seen: string | null;
  app_version: string | null;
  platform: string | null;
  /** Distinct models this user called (admin payload, optional). */
  models?: string[];
};

type Grand = {
  users: number;
  runs: number;
  calls: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  reasoning_tokens: number;
  /** Spend per model across all users (admin payload, optional). */
  by_model?: ModelRow[];
};

type ModelRow = {
  model: string;
  calls: number;
  runs?: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  cost_usd: number;
  saved_usd?: number;
  cache_hits?: number;
  features?: string[];
};

type FeatureRow = {
  feature: string;
  calls: number;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  saved_usd: number;
  cache_hits: number;
};

type CallRow = {
  event_id: string;
  ts: string;
  feature: string;
  sync_mode: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  saved_usd?: number;
  duration_ms: number;
  status: string;
  cache_hit: boolean;
  usage_missing: boolean;
};

type RunKind =
  | "hard_sync"
  | "sync"
  | "research"
  | "translate"
  | "onboarding"
  | "tracker"
  | "other";

type RunRow = {
  run_id: string;
  kind?: RunKind | string;
  kind_detail?: string | null;
  sync_mode?: "hard" | "incremental" | null;
  calls: number;
  features: string[];
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  first_ts: string | null;
  last_ts: string | null;
  models?: string[];
  events?: CallRow[];
};

type SelfReport = {
  scope: "self";
  adminAvailable: boolean;
  telemetryEnabled: boolean;
  user: {
    user_id: string;
    first_seen: string | null;
    last_seen: string | null;
    app_version: string | null;
    platform: string | null;
  };
  totals: {
    runs: number;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    cost_usd: number;
    saved_usd: number;
    first_event_at: string | null;
    last_event_at: string | null;
  };
  by_feature: FeatureRow[];
  by_model?: ModelRow[];
  runs: RunRow[];
};

type UserDetail = {
  user: {
    user_id: string;
    first_seen: string | null;
    last_seen: string | null;
    app_version: string | null;
    platform: string | null;
  };
  totals: {
    runs: number;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    cost_usd: number;
    saved_usd: number;
    first_event_at: string | null;
    last_event_at: string | null;
  };
  by_feature: FeatureRow[];
  by_model?: ModelRow[];
  runs: RunRow[];
};

type TFn = (key: string, vars?: TVars) => string;

function dash(t: TFn): string {
  return t("usage.dash");
}

function fmtUsd(n: number, t: TFn): string {
  if (!Number.isFinite(n)) return dash(t);
  if (n < 0.01 && n > 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number, t: TFn): string {
  if (!Number.isFinite(n)) return dash(t);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtWhen(iso: string | null | undefined, t: TFn): string {
  if (!iso) return dash(t);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  let h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const hh = String(h).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} ${hh}:${min} ${ampm}`;
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function fmtDuration(ms: number, t: TFn): string {
  if (!Number.isFinite(ms) || ms <= 0) return dash(t);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const KIND_KEYS = new Set<string>([
  "hard_sync",
  "sync",
  "research",
  "translate",
  "onboarding",
  "tracker",
  "other",
]);

function resolveRunKind(r: RunRow): RunKind {
  if (r.kind && KIND_KEYS.has(r.kind)) return r.kind as RunKind;
  // Legacy admin payloads / old labels
  if (r.sync_mode === "hard") return "hard_sync";
  if (r.sync_mode === "incremental") return "sync";
  if (r.features.some((f) => f.startsWith("research."))) return "research";
  if (r.features.some((f) => f === "i18n.translate")) return "translate";
  if (r.features.some((f) => f.startsWith("onboarding."))) return "onboarding";
  if (r.features.some((f) => f.startsWith("tracker."))) return "tracker";
  return "other";
}

function runKindLabel(r: RunRow, t: TFn): string {
  const kind = resolveRunKind(r);
  if (kind === "other") {
    return r.kind_detail || r.features[0] || t("usage.kind.other");
  }
  return t(`usage.kind.${kind}`);
}

function syncModeLabel(mode: string | null, t: TFn): string | null {
  if (!mode) return null;
  if (mode === "hard" || mode === "incremental") {
    return t(`usage.syncMode.${mode}`);
  }
  return mode;
}

function callStatusLabel(c: CallRow, t: TFn): { text: string; tone: string } {
  if (c.cache_hit) return { text: t("usage.status.cache"), tone: "cache" };
  if (c.usage_missing) {
    return { text: t("usage.status.missing"), tone: "missing" };
  }
  const s = c.status || "";
  if (
    s === "ok" ||
    s === "error" ||
    s === "timeout" ||
    s === "canceled" ||
    s === "cache_hit"
  ) {
    return { text: t(`usage.status.${s}`), tone: s === "cache_hit" ? "cache" : s };
  }
  if (!s) return { text: t("usage.status.unknown"), tone: "unknown" };
  return { text: s, tone: s };
}

function UsageAccordion({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="cmae-usage-acc">
      <summary className="cmae-usage-acc-sum">
        <span className="cmae-usage-acc-title">{title}</span>
        <span className="cmae-usage-acc-chevron" aria-hidden="true" />
      </summary>
      <div className="cmae-usage-acc-body">{children}</div>
    </details>
  );
}

function RunsAccordionTable({ runs }: { runs: RunRow[] }) {
  const t = useT();
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  function toggle(runId: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }

  return (
    <div className="cmae-usage-table-wrap">
      <table className="cmae-usage-table is-wide cmae-usage-runs">
        <thead>
          <tr>
            <th className="cmae-usage-runs-toggle-col" aria-hidden="true" />
            <th>{t("usage.colKind")}</th>
            <th>{t("usage.colCalls")}</th>
            <th>{t("usage.colFeatures")}</th>
            <th>{t("usage.colModels")}</th>
            <th>{t("usage.colTokens")}</th>
            <th>{t("usage.colCost")}</th>
            <th>{t("usage.colWhen")}</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const expanded = open.has(r.run_id);
            const events = r.events ?? [];
            const canExpand = events.length > 0;
            return (
              <Fragment key={r.run_id}>
                <tr
                  className={`cmae-usage-run-row${expanded ? " is-open" : ""}${canExpand ? " is-expandable" : ""}`}
                  onClick={canExpand ? () => toggle(r.run_id) : undefined}
                  onKeyDown={
                    canExpand
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggle(r.run_id);
                          }
                        }
                      : undefined
                  }
                  tabIndex={canExpand ? 0 : undefined}
                  aria-expanded={canExpand ? expanded : undefined}
                >
                  <td className="cmae-usage-runs-toggle-col">
                    {canExpand ? (
                      <span
                        className={`cmae-usage-run-chevron${expanded ? " is-open" : ""}`}
                        aria-hidden="true"
                      />
                    ) : null}
                  </td>
                  <td>
                    <strong className="cmae-usage-run-kind">
                      {runKindLabel(r, t)}
                    </strong>
                    <div className="cmae-usage-run-id" title={r.run_id}>
                      <code>{shortId(r.run_id)}</code>
                    </div>
                  </td>
                  <td>{r.calls}</td>
                  <td className="cmae-usage-features">
                    {r.features.join(", ")}
                  </td>
                  <td className="cmae-usage-features">
                    {(r.models ?? []).join(", ") || dash(t)}
                  </td>
                  <td>
                    {t("usage.tokensInOut", {
                      input: fmtTokens(
                        r.input_tokens + r.cache_read_tokens,
                        t,
                      ),
                      output: fmtTokens(r.output_tokens, t),
                    })}
                  </td>
                  <td>{fmtUsd(r.cost_usd, t)}</td>
                  <td>{fmtWhen(r.last_ts, t)}</td>
                </tr>
                {expanded && canExpand ? (
                  <tr className="cmae-usage-run-child-row">
                    <td colSpan={7}>
                      <table className="cmae-usage-table cmae-usage-calls">
                        <thead>
                          <tr>
                            <th>{t("usage.colFeature")}</th>
                            <th>{t("usage.colStatus")}</th>
                            <th>{t("usage.colModel")}</th>
                            <th>{t("usage.colIn")}</th>
                            <th>{t("usage.colOut")}</th>
                            <th>{t("usage.colCacheRead")}</th>
                            <th>{t("usage.colCacheWrite")}</th>
                            <th>{t("usage.colReasoning")}</th>
                            <th>{t("usage.colCost")}</th>
                            <th>{t("usage.colSaved")}</th>
                            <th>{t("usage.colDuration")}</th>
                            <th>{t("usage.colWhen")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {events.map((c) => {
                            const st = callStatusLabel(c, t);
                            const mode = syncModeLabel(c.sync_mode, t);
                            return (
                              <tr key={c.event_id}>
                                <td>
                                  <code>{c.feature}</code>
                                  {mode ? (
                                    <span className="cmae-usage-call-mode">
                                      {" "}
                                      · {mode}
                                    </span>
                                  ) : null}
                                </td>
                                <td>
                                  <span
                                    className={`cmae-usage-call-status is-${st.tone}`}
                                  >
                                    {st.text}
                                  </span>
                                </td>
                                <td className="cmae-usage-call-model">
                                  {c.model}
                                </td>
                                <td>{fmtTokens(c.input_tokens, t)}</td>
                                <td>{fmtTokens(c.output_tokens, t)}</td>
                                <td>
                                  {c.cache_read_tokens > 0
                                    ? fmtTokens(c.cache_read_tokens, t)
                                    : dash(t)}
                                </td>
                                <td>
                                  {c.cache_write_tokens > 0
                                    ? fmtTokens(c.cache_write_tokens, t)
                                    : dash(t)}
                                </td>
                                <td>
                                  {c.reasoning_tokens > 0
                                    ? fmtTokens(c.reasoning_tokens, t)
                                    : dash(t)}
                                </td>
                                <td>{fmtUsd(c.cost_usd, t)}</td>
                                <td>{fmtUsd(c.saved_usd ?? 0, t)}</td>
                                <td>{fmtDuration(c.duration_ms, t)}</td>
                                <td>{fmtWhen(c.ts, t)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ModelsTable({ rows }: { rows: ModelRow[] }) {
  const t = useT();
  return (
    <div className="cmae-usage-table-wrap">
      <table className="cmae-usage-table is-wide">
        <thead>
          <tr>
            <th>{t("usage.colModel")}</th>
            <th>{t("usage.colFeatures")}</th>
            <th>{t("usage.colCalls")}</th>
            <th>{t("usage.colInput")}</th>
            <th>{t("usage.colOutput")}</th>
            <th>{t("usage.colCacheRead")}</th>
            <th>{t("usage.colCacheHits")}</th>
            <th>{t("usage.colCost")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.model}>
              <td>
                <code>{m.model}</code>
              </td>
              <td className="cmae-usage-features">
                {(m.features ?? []).join(", ") || dash(t)}
              </td>
              <td>{m.calls}</td>
              <td>{fmtTokens(m.input_tokens, t)}</td>
              <td>{fmtTokens(m.output_tokens, t)}</td>
              <td>{fmtTokens(m.cache_read_tokens, t)}</td>
              <td>{m.cache_hits ?? dash(t)}</td>
              <td>{fmtUsd(m.cost_usd, t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailBody({ detail }: { detail: UserDetail }) {
  const t = useT();
  return (
    <>
      <header className="cmae-usage-detail-head">
        <h2 title={detail.user.user_id}>{detail.user.user_id}</h2>
        <p>
          {detail.user.platform || dash(t)}
          {detail.user.app_version ? ` · v${detail.user.app_version}` : ""}
          {" · "}
          {t("usage.first", {
            when: fmtWhen(
              detail.totals.first_event_at || detail.user.first_seen,
              t,
            ),
          })}
          {" · "}
          {t("usage.last", {
            when: fmtWhen(
              detail.totals.last_event_at || detail.user.last_seen,
              t,
            ),
          })}
        </p>
      </header>

      <div className="cmae-usage-grand is-detail">
        <div>
          <span className="cmae-usage-kpi-label">
            {t("usage.kpiDistinctRuns")}
          </span>
          <strong>{detail.totals.runs}</strong>
        </div>
        <div>
          <span className="cmae-usage-kpi-label">{t("usage.kpiAiCalls")}</span>
          <strong>{detail.totals.calls}</strong>
        </div>
        <div>
          <span className="cmae-usage-kpi-label">{t("usage.kpiTotalCost")}</span>
          <strong>{fmtUsd(detail.totals.cost_usd, t)}</strong>
        </div>
        <div>
          <span className="cmae-usage-kpi-label">
            {t("usage.kpiCacheSaved")}
          </span>
          <strong>{fmtUsd(detail.totals.saved_usd, t)}</strong>
        </div>
      </div>

      <div className="cmae-usage-acc-list">
        <UsageAccordion title={t("usage.accTokenBreakdown")}>
          <table className="cmae-usage-table">
            <tbody>
              <tr>
                <th>{t("usage.colInput")}</th>
                <td>{fmtTokens(detail.totals.input_tokens, t)}</td>
              </tr>
              <tr>
                <th>{t("usage.colOutput")}</th>
                <td>{fmtTokens(detail.totals.output_tokens, t)}</td>
              </tr>
              <tr>
                <th>{t("usage.colCacheRead")}</th>
                <td>{fmtTokens(detail.totals.cache_read_tokens, t)}</td>
              </tr>
              <tr>
                <th>{t("usage.colCacheWrite")}</th>
                <td>{fmtTokens(detail.totals.cache_write_tokens, t)}</td>
              </tr>
              <tr>
                <th>{t("usage.colReasoning")}</th>
                <td>{fmtTokens(detail.totals.reasoning_tokens, t)}</td>
              </tr>
            </tbody>
          </table>
        </UsageAccordion>

        {detail.by_model && detail.by_model.length > 0 ? (
          <UsageAccordion title={t("usage.accByModel")}>
            <ModelsTable rows={detail.by_model} />
          </UsageAccordion>
        ) : null}

        <UsageAccordion title={t("usage.accByFeature")}>
          {detail.by_feature.length === 0 ? (
            <p className="cmae-muted">{t("usage.noCalls")}</p>
          ) : (
            <div className="cmae-usage-table-wrap">
              <table className="cmae-usage-table is-wide">
                <thead>
                  <tr>
                    <th>{t("usage.colFeature")}</th>
                    <th>{t("usage.colRun")}</th>
                    <th>{t("usage.colCalls")}</th>
                    <th>{t("usage.colInput")}</th>
                    <th>{t("usage.colOutput")}</th>
                    <th>{t("usage.colCacheRead")}</th>
                    <th>{t("usage.colCacheWrite")}</th>
                    <th>{t("usage.colReasoning")}</th>
                    <th>{t("usage.colSaved")}</th>
                    <th>{t("usage.colCacheHits")}</th>
                    <th>{t("usage.colCost")}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.by_feature.map((f) => (
                    <tr key={f.feature}>
                      <td>
                        <code>{f.feature}</code>
                      </td>
                      <td>{f.runs}</td>
                      <td>{f.calls}</td>
                      <td>{fmtTokens(f.input_tokens, t)}</td>
                      <td>{fmtTokens(f.output_tokens, t)}</td>
                      <td>{fmtTokens(f.cache_read_tokens, t)}</td>
                      <td>{fmtTokens(f.cache_write_tokens, t)}</td>
                      <td>{fmtTokens(f.reasoning_tokens, t)}</td>
                      <td>{fmtUsd(f.saved_usd, t)}</td>
                      <td>{f.cache_hits}</td>
                      <td>{fmtUsd(f.cost_usd, t)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </UsageAccordion>

        <UsageAccordion title={t("usage.accRecentRuns")}>
          <p className="cmae-muted cmae-usage-hint">{t("usage.runsHint")}</p>
          {detail.runs.length === 0 ? (
            <p className="cmae-muted">{t("usage.noRuns")}</p>
          ) : (
            <RunsAccordionTable runs={detail.runs} />
          )}
        </UsageAccordion>
      </div>
    </>
  );
}

export function UsageReport() {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [self, setSelf] = useState<SelfReport | null>(null);
  const [adminAvailable, setAdminAvailable] = useState(false);
  const [mode, setMode] = useState<"self" | "admin">("self");
  const [grand, setGrand] = useState<Grand | null>(null);
  const [users, setUsers] = useState<UserCard[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadSelf = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/usage-report", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.message || body?.error || String(res.status));
        setSelf(null);
        return;
      }
      const report = body as SelfReport;
      setSelf(report);
      setAdminAvailable(Boolean(report.adminAvailable));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAdminList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/usage-report?admin=1", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) {
        if (body?.error === "admin_unavailable") {
          setAdminAvailable(false);
          setMode("self");
          setError(null);
          return;
        }
        setError(body?.error || String(res.status));
        setUsers([]);
        setGrand(null);
        return;
      }
      setAdminAvailable(true);
      setGrand(body.grand ?? null);
      setUsers(Array.isArray(body.users) ? body.users : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode === "self") {
      setSelected(null);
      setDetail(null);
      void loadSelf();
    } else {
      void loadAdminList();
    }
  }, [mode, loadSelf, loadAdminList]);

  useEffect(() => {
    if (mode !== "admin" || !selected) {
      if (mode === "admin" && !selected) setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/usage-report?admin=1&user_id=${encodeURIComponent(selected)}`,
          { cache: "no-store" },
        );
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(body?.error || String(res.status));
          setDetail(null);
          return;
        }
        setDetail(body as UserDetail);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, selected]);

  return (
    <PageShell
      title={t("usage.title")}
      subtitle={
        mode === "admin" ? t("usage.subtitleAdmin") : t("usage.subtitleSelf")
      }
    >
      <div className="cmae-usage-toolbar">
        <Button
          type="button"
          variant="ghost"
          onClick={() =>
            void (mode === "self" ? loadSelf() : loadAdminList())
          }
          disabled={loading}
        >
          {t("usage.refresh")}
        </Button>
        {adminAvailable ? (
          mode === "self" ? (
            <Button type="button" variant="ghost" onClick={() => setMode("admin")}>
              {t("usage.allUsers")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSelected(null);
                setMode("self");
              }}
            >
              {t("usage.myUsage")}
            </Button>
          )
        ) : null}
        {mode === "admin" && selected ? (
          <Button type="button" variant="ghost" onClick={() => setSelected(null)}>
            {t("usage.userList")}
          </Button>
        ) : null}
      </div>

      {error ? <p className="cmae-usage-error">{error}</p> : null}
      {loading && !(mode === "admin" && selected) ? (
        <p className="cmae-muted">{t("usage.loading")}</p>
      ) : null}

      {mode === "self" && self && !loading ? (
        <div className="cmae-usage-detail">
          {!self.telemetryEnabled ? (
            <p className="cmae-muted cmae-usage-hint">
              {t("usage.telemetryOff")}
            </p>
          ) : null}
          <DetailBody detail={self} />
        </div>
      ) : null}

      {mode === "admin" && !selected && grand ? (
        <div className="cmae-usage-grand">
          <div>
            <span className="cmae-usage-kpi-label">{t("usage.kpiUsers")}</span>
            <strong>{grand.users}</strong>
          </div>
          <div>
            <span className="cmae-usage-kpi-label">{t("usage.kpiRuns")}</span>
            <strong>{grand.runs}</strong>
          </div>
          <div>
            <span className="cmae-usage-kpi-label">{t("usage.kpiAiCalls")}</span>
            <strong>{grand.calls}</strong>
          </div>
          <div>
            <span className="cmae-usage-kpi-label">{t("usage.kpiTotalCost")}</span>
            <strong>{fmtUsd(grand.cost_usd, t)}</strong>
          </div>
          <div>
            <span className="cmae-usage-kpi-label">
              {t("usage.kpiInputOutput")}
            </span>
            <strong>
              {fmtTokens(grand.input_tokens, t)} /{" "}
              {fmtTokens(grand.output_tokens, t)}
            </strong>
          </div>
          <div>
            <span className="cmae-usage-kpi-label">
              {t("usage.kpiCacheRead")}
            </span>
            <strong>{fmtTokens(grand.cache_read_tokens, t)}</strong>
          </div>
        </div>
      ) : null}

      {mode === "admin" && !selected && grand?.by_model?.length ? (
        <div className="cmae-usage-detail">
          <UsageAccordion title={t("usage.accByModel")}>
            <ModelsTable rows={grand.by_model} />
          </UsageAccordion>
        </div>
      ) : null}

      {mode === "admin" && !selected && !loading ? (
        <div className="cmae-usage-grid">
          {users.length === 0 ? (
            <p className="cmae-muted">{t("usage.noUsers")}</p>
          ) : (
            users.map((u) => (
              <button
                key={u.user_id}
                type="button"
                className="cmae-usage-card"
                onClick={() => setSelected(u.user_id)}
              >
                <div className="cmae-usage-card-id" title={u.user_id}>
                  {u.user_id}
                </div>
                <div className="cmae-usage-card-meta">
                  {u.platform || dash(t)}
                  {u.app_version ? ` · v${u.app_version}` : ""}
                </div>
                <div className="cmae-usage-card-stats">
                  <span>
                    <em>{u.runs}</em> {t("usage.unitRuns")}
                  </span>
                  <span>
                    <em>{u.calls}</em> {t("usage.unitCalls")}
                  </span>
                  <span>
                    <em>{fmtUsd(u.cost_usd, t)}</em>
                  </span>
                </div>
                <div className="cmae-usage-card-tokens">
                  {t("usage.cardTokens", {
                    input: fmtTokens(u.input_tokens, t),
                    output: fmtTokens(u.output_tokens, t),
                    cache: fmtTokens(u.cache_read_tokens, t),
                  })}
                </div>
                {u.models?.length ? (
                  <div className="cmae-usage-card-meta" title={u.models.join(", ")}>
                    {u.models.length <= 2
                      ? u.models.join(", ")
                      : t("usage.cardModels", { count: u.models.length })}
                  </div>
                ) : null}
                <div className="cmae-usage-card-when">
                  {t("usage.lastLabel", {
                    when: fmtWhen(u.last_event_at || u.last_seen, t),
                  })}
                </div>
              </button>
            ))
          )}
        </div>
      ) : null}

      {mode === "admin" && selected ? (
        <div className="cmae-usage-detail">
          {detailLoading || !detail ? (
            <p className="cmae-muted">{t("usage.loadingDetail")}</p>
          ) : (
            <DetailBody detail={detail} />
          )}
        </div>
      ) : null}
    </PageShell>
  );
}
