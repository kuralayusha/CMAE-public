/**
 * Local Usage page report — aggregates ai_usage_events for this machine.
 * No Supabase / report secret required.
 */

import type Database from "better-sqlite3";
import { getSqlite } from "@/lib/db/client";
import { getAnonId } from "./anon-id";
import { isTelemetryEnabled } from "./store";

export type LocalFeatureRow = {
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

export type LocalModelRow = {
  model: string;
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
  /** Features this model served, most-called first. */
  features: string[];
};

export type LocalCallRow = {
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
  saved_usd: number;
  duration_ms: number;
  status: string;
  cache_hit: boolean;
  usage_missing: boolean;
};

/** Stable run-kind keys — UI maps via `usage.kind.*` i18n. */
export type LocalRunKind =
  | "hard_sync"
  | "sync"
  | "research"
  | "translate"
  | "onboarding"
  | "tracker"
  | "other";

export type LocalRunRow = {
  run_id: string;
  kind: LocalRunKind;
  /** When kind is `other`, raw feature id for display fallback. */
  kind_detail: string | null;
  sync_mode: "hard" | "incremental" | null;
  calls: number;
  features: string[];
  /** Distinct models used in this run (a run can mix fast + smart models). */
  models: string[];
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  first_ts: string | null;
  last_ts: string | null;
  events: LocalCallRow[];
};

/** Derive a stable kind key for a run from sync_mode + feature set. */
export function runKindLabel(
  syncModes: Array<string | null | undefined>,
  features: string[],
): {
  kind: LocalRunKind;
  kind_detail: string | null;
  sync_mode: "hard" | "incremental" | null;
} {
  const modes = new Set(
    syncModes.map((m) => (m || "").trim()).filter(Boolean),
  );
  if (modes.has("hard")) {
    return { kind: "hard_sync", kind_detail: null, sync_mode: "hard" };
  }
  if (modes.has("incremental")) {
    return { kind: "sync", kind_detail: null, sync_mode: "incremental" };
  }
  if (features.some((f) => f.startsWith("research."))) {
    return { kind: "research", kind_detail: null, sync_mode: null };
  }
  if (features.some((f) => f === "i18n.translate")) {
    return { kind: "translate", kind_detail: null, sync_mode: null };
  }
  if (features.some((f) => f.startsWith("onboarding."))) {
    return { kind: "onboarding", kind_detail: null, sync_mode: null };
  }
  if (features.some((f) => f.startsWith("tracker."))) {
    return { kind: "tracker", kind_detail: null, sync_mode: null };
  }
  return {
    kind: "other",
    kind_detail: features[0] || null,
    sync_mode: null,
  };
}

export type LocalUsageReport = {
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
  by_feature: LocalFeatureRow[];
  by_model: LocalModelRow[];
  runs: LocalRunRow[];
};

function microToUsd(micro: number): number {
  return Math.round(micro) / 1_000_000;
}

export function buildLocalUsageReport(
  db: Database.Database = getSqlite(),
  opts?: { adminAvailable?: boolean; anonRoot?: string },
): LocalUsageReport {
  const anon = getAnonId({ db, root: opts?.anonRoot });
  const totalsRow = db
    .prepare(
      `SELECT
         COUNT(*) AS calls,
         (
           COUNT(DISTINCT CASE WHEN run_id IS NOT NULL AND run_id != '' THEN run_id END)
           + COALESCE(SUM(CASE WHEN run_id IS NULL OR run_id = '' THEN 1 ELSE 0 END), 0)
         ) AS runs,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
         COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
         COALESCE(SUM(cost_micro_usd), 0) AS cost_micro,
         COALESCE(SUM(saved_cost_micro_usd), 0) AS saved_micro,
         MIN(ts) AS first_ts,
         MAX(ts) AS last_ts
       FROM ai_usage_events`,
    )
    .get() as {
    calls: number;
    runs: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    cost_micro: number;
    saved_micro: number;
    first_ts: string | null;
    last_ts: string | null;
  };

  const featureRows = db
    .prepare(
      `SELECT
         feature,
         COUNT(*) AS calls,
         (
           COUNT(DISTINCT CASE WHEN run_id IS NOT NULL AND run_id != '' THEN run_id END)
           + COALESCE(SUM(CASE WHEN run_id IS NULL OR run_id = '' THEN 1 ELSE 0 END), 0)
         ) AS runs,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
         COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
         COALESCE(SUM(cost_micro_usd), 0) AS cost_micro,
         COALESCE(SUM(saved_cost_micro_usd), 0) AS saved_micro,
         COALESCE(SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END), 0) AS cache_hits
       FROM ai_usage_events
       GROUP BY feature
       ORDER BY cost_micro DESC, calls DESC`,
    )
    .all() as Array<{
    feature: string;
    calls: number;
    runs: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    cost_micro: number;
    saved_micro: number;
    cache_hits: number;
  }>;

  const modelRows = db
    .prepare(
      `SELECT
         model,
         COUNT(*) AS calls,
         (
           COUNT(DISTINCT CASE WHEN run_id IS NOT NULL AND run_id != '' THEN run_id END)
           + COALESCE(SUM(CASE WHEN run_id IS NULL OR run_id = '' THEN 1 ELSE 0 END), 0)
         ) AS runs,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
         COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
         COALESCE(SUM(cost_micro_usd), 0) AS cost_micro,
         COALESCE(SUM(saved_cost_micro_usd), 0) AS saved_micro,
         COALESCE(SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END), 0) AS cache_hits
       FROM ai_usage_events
       GROUP BY model
       ORDER BY cost_micro DESC, calls DESC`,
    )
    .all() as Array<{
    model: string;
    calls: number;
    runs: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    cost_micro: number;
    saved_micro: number;
    cache_hits: number;
  }>;
  const featuresByModel = new Map<string, string[]>();
  for (const r of db
    .prepare(
      `SELECT model, feature FROM ai_usage_events GROUP BY model, feature ORDER BY COUNT(*) DESC`,
    )
    .all() as Array<{ model: string; feature: string }>) {
    const list = featuresByModel.get(r.model) ?? [];
    list.push(r.feature);
    featuresByModel.set(r.model, list);
  }

  const runAgg = db
    .prepare(
      `SELECT
         run_id,
         COUNT(*) AS calls,
         GROUP_CONCAT(DISTINCT feature) AS features,
         GROUP_CONCAT(DISTINCT sync_mode) AS sync_modes,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
         COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
         COALESCE(SUM(cost_micro_usd), 0) AS cost_micro,
         MIN(ts) AS first_ts,
         MAX(ts) AS last_ts
       FROM ai_usage_events
       WHERE run_id IS NOT NULL AND run_id != ''
       GROUP BY run_id
       ORDER BY last_ts DESC`,
    )
    .all() as Array<{
    run_id: string;
    calls: number;
    features: string | null;
    sync_modes: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    cost_micro: number;
    first_ts: string | null;
    last_ts: string | null;
  }>;

  type RawCall = {
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
    cost_micro_usd: number;
    saved_cost_micro_usd: number;
    duration_ms: number;
    status: string;
    cache_hit: number;
    usage_missing: number;
    run_id: string | null;
  };

  const toCall = (c: RawCall): LocalCallRow => ({
    event_id: c.event_id,
    ts: c.ts,
    feature: c.feature,
    sync_mode: c.sync_mode,
    model: c.model,
    input_tokens: c.input_tokens,
    output_tokens: c.output_tokens,
    cache_read_tokens: c.cache_read_tokens,
    cache_write_tokens: c.cache_write_tokens,
    reasoning_tokens: c.reasoning_tokens,
    cost_usd: microToUsd(c.cost_micro_usd),
    saved_usd: microToUsd(c.saved_cost_micro_usd),
    duration_ms: c.duration_ms,
    status: c.status,
    cache_hit: c.cache_hit === 1,
    usage_missing: c.usage_missing === 1,
  });

  const callRows = db
    .prepare(
      `SELECT
         event_id, ts, feature, sync_mode, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         reasoning_tokens, cost_micro_usd, saved_cost_micro_usd, duration_ms, status,
         cache_hit, usage_missing, run_id
       FROM ai_usage_events
       ORDER BY ts ASC`,
    )
    .all() as RawCall[];

  const eventsByRun = new Map<string, LocalCallRow[]>();
  const soloRuns: LocalRunRow[] = [];
  for (const c of callRows) {
    const call = toCall(c);
    const rid = (c.run_id || "").trim();
    if (!rid) {
      const features = [c.feature];
      const labeled = runKindLabel([c.sync_mode], features);
      soloRuns.push({
        run_id: `solo:${c.event_id}`,
        kind: labeled.kind,
        kind_detail: labeled.kind_detail,
        sync_mode: labeled.sync_mode,
        calls: 1,
        features,
        models: [c.model],
        input_tokens: c.input_tokens,
        output_tokens: c.output_tokens,
        cache_read_tokens: c.cache_read_tokens,
        cache_write_tokens: c.cache_write_tokens,
        reasoning_tokens: c.reasoning_tokens,
        cost_usd: microToUsd(c.cost_micro_usd),
        first_ts: c.ts,
        last_ts: c.ts,
        events: [call],
      });
      continue;
    }
    const list = eventsByRun.get(rid) ?? [];
    list.push(call);
    eventsByRun.set(rid, list);
  }

  return {
    scope: "self",
    adminAvailable: Boolean(opts?.adminAvailable),
    telemetryEnabled: isTelemetryEnabled(db),
    user: {
      user_id: anon.userId,
      first_seen: totalsRow.first_ts,
      last_seen: totalsRow.last_ts,
      app_version: null,
      platform: process.platform || null,
    },
    totals: {
      runs: totalsRow.runs,
      calls: totalsRow.calls,
      input_tokens: totalsRow.input_tokens,
      output_tokens: totalsRow.output_tokens,
      cache_read_tokens: totalsRow.cache_read_tokens,
      cache_write_tokens: totalsRow.cache_write_tokens,
      reasoning_tokens: totalsRow.reasoning_tokens,
      cost_usd: microToUsd(totalsRow.cost_micro),
      saved_usd: microToUsd(totalsRow.saved_micro),
      first_event_at: totalsRow.first_ts,
      last_event_at: totalsRow.last_ts,
    },
    by_feature: featureRows.map((f) => ({
      feature: f.feature,
      calls: f.calls,
      runs: f.runs,
      input_tokens: f.input_tokens,
      output_tokens: f.output_tokens,
      cache_read_tokens: f.cache_read_tokens,
      cache_write_tokens: f.cache_write_tokens,
      reasoning_tokens: f.reasoning_tokens,
      cost_usd: microToUsd(f.cost_micro),
      saved_usd: microToUsd(f.saved_micro),
      cache_hits: f.cache_hits,
    })),
    by_model: modelRows.map((m) => ({
      model: m.model,
      calls: m.calls,
      runs: m.runs,
      input_tokens: m.input_tokens,
      output_tokens: m.output_tokens,
      cache_read_tokens: m.cache_read_tokens,
      cache_write_tokens: m.cache_write_tokens,
      reasoning_tokens: m.reasoning_tokens,
      cost_usd: microToUsd(m.cost_micro),
      saved_usd: microToUsd(m.saved_micro),
      cache_hits: m.cache_hits,
      features: featuresByModel.get(m.model) ?? [],
    })),
    runs: [
      ...runAgg.map((r) => {
        const features = (r.features || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const syncModes = (r.sync_modes || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const { kind, kind_detail, sync_mode } = runKindLabel(syncModes, features);
        return {
          run_id: r.run_id,
          kind,
          kind_detail,
          sync_mode,
          calls: r.calls,
          features,
          models: [...new Set((eventsByRun.get(r.run_id) ?? []).map((e) => e.model))],
          input_tokens: r.input_tokens,
          output_tokens: r.output_tokens,
          cache_read_tokens: r.cache_read_tokens,
          cache_write_tokens: r.cache_write_tokens,
          reasoning_tokens: r.reasoning_tokens,
          cost_usd: microToUsd(r.cost_micro),
          first_ts: r.first_ts,
          last_ts: r.last_ts,
          events: eventsByRun.get(r.run_id) ?? [],
        };
      }),
      ...soloRuns,
    ].sort((a, b) => (b.last_ts || "").localeCompare(a.last_ts || "")),
  };
}
