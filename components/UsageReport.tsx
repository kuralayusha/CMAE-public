"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, PageShell } from "@/components/ui";

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

type RunRow = {
  run_id: string;
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
  runs: RunRow[];
};

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 0.01 && n > 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export function UsageReport() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [grand, setGrand] = useState<Grand | null>(null);
  const [users, setUsers] = useState<UserCard[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/usage-report", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) {
        const hint = typeof body?.hint === "string" ? ` — ${body.hint}` : "";
        setError(`${body?.error || res.status}${hint}`);
        setUsers([]);
        setGrand(null);
        return;
      }
      setGrand(body.grand ?? null);
      setUsers(Array.isArray(body.users) ? body.users : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/usage-report?user_id=${encodeURIComponent(selected)}`,
          { cache: "no-store" },
        );
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(`${body?.error || res.status}`);
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
  }, [selected]);

  return (
    <PageShell
      title="Usage raporu"
      subtitle="Supabase CMAE telemetry — kullanıcı kartları, run ve token kırılımı"
    >
      <div className="cmae-usage-toolbar">
        <Button type="button" variant="ghost" onClick={() => void loadList()} disabled={loading}>
          Yenile
        </Button>
        {selected ? (
          <Button type="button" variant="ghost" onClick={() => setSelected(null)}>
            ← Kullanıcı listesi
          </Button>
        ) : null}
      </div>

      {error ? <p className="cmae-usage-error">{error}</p> : null}
      {loading && !selected ? <p className="cmae-muted">Yükleniyor…</p> : null}

      {!selected && grand ? (
        <div className="cmae-usage-grand">
          <div>
            <span className="cmae-usage-kpi-label">Kullanıcı</span>
            <strong>{grand.users}</strong>
          </div>
          <div>
            <span className="cmae-usage-kpi-label">Run</span>
            <strong>{grand.runs}</strong>
          </div>
          <div>
            <span className="cmae-usage-kpi-label">AI çağrısı</span>
            <strong>{grand.calls}</strong>
          </div>
          <div>
            <span className="cmae-usage-kpi-label">Toplam maliyet</span>
            <strong>{fmtUsd(grand.cost_usd)}</strong>
          </div>
          <div>
            <span className="cmae-usage-kpi-label">Input / output</span>
            <strong>
              {fmtTokens(grand.input_tokens)} / {fmtTokens(grand.output_tokens)}
            </strong>
          </div>
          <div>
            <span className="cmae-usage-kpi-label">Cache read</span>
            <strong>{fmtTokens(grand.cache_read_tokens)}</strong>
          </div>
        </div>
      ) : null}

      {!selected && !loading ? (
        <div className="cmae-usage-grid">
          {users.length === 0 ? (
            <p className="cmae-muted">Henüz kullanıcı yok.</p>
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
                  {u.platform || "—"}
                  {u.app_version ? ` · v${u.app_version}` : ""}
                </div>
                <div className="cmae-usage-card-stats">
                  <span>
                    <em>{u.runs}</em> run
                  </span>
                  <span>
                    <em>{u.calls}</em> çağrı
                  </span>
                  <span>
                    <em>{fmtUsd(u.cost_usd)}</em>
                  </span>
                </div>
                <div className="cmae-usage-card-tokens">
                  in {fmtTokens(u.input_tokens)} · out {fmtTokens(u.output_tokens)} ·
                  cache {fmtTokens(u.cache_read_tokens)}
                </div>
                <div className="cmae-usage-card-when">
                  Son: {fmtWhen(u.last_event_at || u.last_seen)}
                </div>
              </button>
            ))
          )}
        </div>
      ) : null}

      {selected ? (
        <div className="cmae-usage-detail">
          {detailLoading || !detail ? (
            <p className="cmae-muted">Detay yükleniyor…</p>
          ) : (
            <>
              <header className="cmae-usage-detail-head">
                <h2 title={detail.user.user_id}>{detail.user.user_id}</h2>
                <p>
                  {detail.user.platform || "—"}
                  {detail.user.app_version ? ` · v${detail.user.app_version}` : ""}
                  {" · "}
                  ilk {fmtWhen(detail.totals.first_event_at || detail.user.first_seen)}
                  {" · "}
                  son {fmtWhen(detail.totals.last_event_at || detail.user.last_seen)}
                </p>
              </header>

              <div className="cmae-usage-grand is-detail">
                <div>
                  <span className="cmae-usage-kpi-label">Farklı run</span>
                  <strong>{detail.totals.runs}</strong>
                </div>
                <div>
                  <span className="cmae-usage-kpi-label">AI çağrısı</span>
                  <strong>{detail.totals.calls}</strong>
                </div>
                <div>
                  <span className="cmae-usage-kpi-label">Toplam para</span>
                  <strong>{fmtUsd(detail.totals.cost_usd)}</strong>
                </div>
                <div>
                  <span className="cmae-usage-kpi-label">Tasarruf (cache)</span>
                  <strong>{fmtUsd(detail.totals.saved_usd)}</strong>
                </div>
              </div>

              <section className="cmae-usage-section">
                <h3>Token kırılımı</h3>
                <table className="cmae-usage-table">
                  <tbody>
                    <tr>
                      <th>Input</th>
                      <td>{fmtTokens(detail.totals.input_tokens)}</td>
                    </tr>
                    <tr>
                      <th>Output</th>
                      <td>{fmtTokens(detail.totals.output_tokens)}</td>
                    </tr>
                    <tr>
                      <th>Cache read</th>
                      <td>{fmtTokens(detail.totals.cache_read_tokens)}</td>
                    </tr>
                    <tr>
                      <th>Cache write</th>
                      <td>{fmtTokens(detail.totals.cache_write_tokens)}</td>
                    </tr>
                    <tr>
                      <th>Reasoning</th>
                      <td>{fmtTokens(detail.totals.reasoning_tokens)}</td>
                    </tr>
                  </tbody>
                </table>
              </section>

              <section className="cmae-usage-section">
                <h3>Feature’a göre</h3>
                <div className="cmae-usage-table-wrap">
                  <table className="cmae-usage-table is-wide">
                    <thead>
                      <tr>
                        <th>Feature</th>
                        <th>Run</th>
                        <th>Çağrı</th>
                        <th>Input</th>
                        <th>Output</th>
                        <th>Cache</th>
                        <th>Maliyet</th>
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
                          <td>{fmtTokens(f.input_tokens)}</td>
                          <td>{fmtTokens(f.output_tokens)}</td>
                          <td>{fmtTokens(f.cache_read_tokens)}</td>
                          <td>{fmtUsd(f.cost_usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="cmae-usage-section">
                <h3>Son run’lar</h3>
                <p className="cmae-muted cmae-usage-hint">
                  Aynı run_id = tek bir UI run (hard/incremental sync, research,
                  çeviri). Run dışı tekil AI çağrılarının run_id’si yoktur.
                </p>
                <div className="cmae-usage-table-wrap">
                  <table className="cmae-usage-table is-wide">
                    <thead>
                      <tr>
                        <th>Run</th>
                        <th>Çağrı</th>
                        <th>Feature’lar</th>
                        <th>Token</th>
                        <th>Maliyet</th>
                        <th>Zaman</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.runs.map((r) => (
                        <tr key={r.run_id}>
                          <td title={r.run_id}>
                            <code>{shortId(r.run_id)}</code>
                          </td>
                          <td>{r.calls}</td>
                          <td className="cmae-usage-features">
                            {r.features.join(", ")}
                          </td>
                          <td>
                            {fmtTokens(r.input_tokens + r.cache_read_tokens)} in ·{" "}
                            {fmtTokens(r.output_tokens)} out
                          </td>
                          <td>{fmtUsd(r.cost_usd)}</td>
                          <td>{fmtWhen(r.last_ts)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </div>
      ) : null}
    </PageShell>
  );
}
