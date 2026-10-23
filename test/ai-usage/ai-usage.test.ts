/**
 * AI usage unit tests (node:test via tsx):
 *   node --import tsx --test test/ai-usage/ai-usage.test.ts
 *
 * Uses explicit temp dirs / DB handles only — never getAppRoot(), which would
 * rewrite the user's ~/.cmae-app-root sticky file.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Agent } from "@cursor/sdk";
import Database from "better-sqlite3";
import { getAnonId, regenerateAnonId, anonIdPath } from "../../lib/ai-usage/anon-id";
import { promptWithUsage } from "../../lib/ai-usage/call";
import { cacheKey } from "../../lib/ai-usage/cache-key";
import { cacheGet, cachePrune, cachePut } from "../../lib/ai-usage/cache";
import {
  AI_FEATURES,
  isCacheableFeature,
  type AiFeature,
} from "../../lib/ai-usage/features";
import {
  computeCostMicroUsd,
  EMBEDDED_PRICES,
  parsePriceTable,
  selectPrice,
} from "../../lib/ai-usage/pricing";
import { buildLocalUsageReport } from "../../lib/ai-usage/local-report";
import { createDbBackend, recordImportedTranslateUsage, setTelemetryEnabled } from "../../lib/ai-usage/store";
import {
  resetUploaderState,
  uploadPending,
  uploaderBackoffUntil,
} from "../../lib/ai-usage/uploader";
import { MIGRATIONS } from "../../lib/db/migrations";

let dir: string;
let db: Database.Database;

function openDb(): Database.Database {
  const file = path.join(dir, "cmae.db");
  const d = new Database(file);
  // Apply directly: runMigrations() fires an un-awaited async sqlite backup per version.
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) m.up(d);
  return d;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmae-ai-usage-"));
  db = openDb();
  resetUploaderState();
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
describe("cost formula", () => {
  const price = EMBEDDED_PRICES.prices[0]!;

  it("bills uncached input, cache read, output separately (micro-USD integer)", () => {
    const cost = computeCostMicroUsd(
      { inputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 0, outputTokens: 500 },
      price,
    );
    // 1000*0.5 + 2000*0.2 + 500*2.5 = 500 + 400 + 1250
    assert.equal(cost, 2150);
    assert.ok(Number.isInteger(cost));
  });

  it("1M tokens of each bucket = listed USD price in micro-USD", () => {
    const M = 1_000_000;
    assert.equal(
      computeCostMicroUsd(
        { inputTokens: M, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
        price,
      ),
      500_000,
    );
    assert.equal(
      computeCostMicroUsd(
        { inputTokens: 0, cacheReadTokens: M, cacheWriteTokens: 0, outputTokens: 0 },
        price,
      ),
      200_000,
    );
    assert.equal(
      computeCostMicroUsd(
        { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: M },
        price,
      ),
      2_500_000,
    );
  });

  it("reasoning tokens are a subset of output and never added again", () => {
    const base = { inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0, outputTokens: 400 };
    const withReasoning = { ...base, reasoningTokens: 300 };
    assert.equal(computeCostMicroUsd(withReasoning, price), computeCostMicroUsd(base, price));
  });

  it("cache write is free for composer-2.5", () => {
    assert.equal(
      computeCostMicroUsd(
        { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 5000, outputTokens: 0 },
        price,
      ),
      0,
    );
  });
});

/* ------------------------------------------------------------------ */
describe("price version selection", () => {
  const table = {
    version: "v2",
    prices: [
      { model: "composer-2.5", input: 0.5, cacheRead: 0.2, cacheWrite: 0, output: 2.5, validFrom: "2026-01-01T00:00:00Z" },
      { model: "composer-2.5", input: 1, cacheRead: 0.4, cacheWrite: 0, output: 5, validFrom: "2026-06-01T00:00:00Z" },
      { model: "other", input: 9, cacheRead: 9, cacheWrite: 9, output: 9, validFrom: "2026-01-01T00:00:00Z" },
    ],
  };

  it("picks the latest price valid at the call time", () => {
    assert.equal(selectPrice(table, "composer-2.5", "2026-03-01T00:00:00Z").input, 0.5);
    assert.equal(selectPrice(table, "composer-2.5", "2026-07-01T00:00:00Z").input, 1);
    assert.equal(selectPrice(table, "other", "2026-07-01T00:00:00Z").input, 9);
  });

  it("unknown model falls back to the default model price", () => {
    assert.equal(selectPrice(table, "nope", "2026-07-01T00:00:00Z").input, 1);
  });

  it("parses a remote table and rejects garbage", () => {
    const ok = parsePriceTable({
      version: "r1",
      prices: [{ model_id: "composer-2.5", input: 0.6, cache_read: 0.3, cache_write: 0, output: 3, valid_from: "2026-02-01" }],
    });
    assert.equal(ok?.version, "r1");
    assert.equal(ok?.prices[0]?.cacheRead, 0.3);
    assert.equal(parsePriceTable({ version: "x", prices: [{ model_id: "m", input: -1 }] }), null);
    assert.equal(parsePriceTable(null), null);
    assert.equal(parsePriceTable({ prices: [] }), null);
  });
});

/* ------------------------------------------------------------------ */
describe("cache key", () => {
  const base = { model: "composer-2.5", feature: "tracker.sync.triage" as AiFeature, promptVersion: 4, prompt: "hello\nworld" };

  it("is stable and ignores line-ending / trailing-whitespace noise", () => {
    assert.equal(cacheKey(base), cacheKey({ ...base }));
    assert.equal(cacheKey(base), cacheKey({ ...base, prompt: "hello  \r\nworld\n" }));
    assert.match(cacheKey(base), /^[0-9a-f]{64}$/);
  });

  it("changes with prompt, model, feature and prompt version", () => {
    const k = cacheKey(base);
    assert.notEqual(k, cacheKey({ ...base, prompt: "hello\nworld!" }));
    assert.notEqual(k, cacheKey({ ...base, model: "other" }));
    assert.notEqual(k, cacheKey({ ...base, feature: "tracker.sync.events" }));
    assert.notEqual(k, cacheKey({ ...base, promptVersion: 5 }));
  });
});

/* ------------------------------------------------------------------ */
describe("cache policy + promptWithUsage", () => {
  const realPrompt = Agent.prompt;
  let calls = 0;
  let withUsage = true;

  beforeEach(() => {
    calls = 0;
    withUsage = true;
    (Agent as unknown as { prompt: unknown }).prompt = async () => {
      calls += 1;
      return {
        id: "run-1",
        status: "finished",
        result: `answer-${calls}`,
        ...(withUsage
          ? {
              usage: {
                inputTokens: 1000,
                outputTokens: 500,
                cacheReadTokens: 2000,
                cacheWriteTokens: 0,
                totalTokens: 3500,
                reasoningTokens: 100,
              },
            }
          : {}),
      };
    };
  });
  afterEach(() => {
    (Agent as unknown as { prompt: unknown }).prompt = realPrompt;
  });

  const run = (feature: AiFeature, extra: Record<string, unknown> = {}) =>
    promptWithUsage({
      feature,
      prompt: "some prompt",
      apiKey: "k",
      cwd: dir,
      backend: createDbBackend(() => db),
      ...extra,
    });

  const events = () =>
    db.prepare(`SELECT * FROM ai_usage_events ORDER BY ts, rowid`).all() as Record<string, number | string>[];

  it("cacheable feature: 2nd identical call is served from cache with 0 tokens", async () => {
    const a = await run("tracker.sync.triage", { syncMode: "incremental" });
    const b = await run("tracker.sync.triage", { syncMode: "incremental" });
    assert.equal(calls, 1);
    assert.equal(a.cached, false);
    assert.equal(b.cached, true);
    assert.equal(b.text, a.text);
    const ev = events();
    assert.equal(ev.length, 2);
    assert.equal(ev[0]!.status, "ok");
    assert.equal(ev[0]!.input_tokens, 1000);
    assert.equal(ev[0]!.cache_read_tokens, 2000);
    assert.equal(ev[0]!.reasoning_tokens, 100);
    assert.equal(ev[0]!.cost_micro_usd, 2150);
    assert.equal(ev[0]!.usage_missing, 0);
    assert.equal(ev[1]!.status, "cache_hit");
    assert.equal(ev[1]!.cache_hit, 1);
    assert.equal(ev[1]!.input_tokens, 0);
    assert.equal(ev[1]!.cost_micro_usd, 0);
    assert.equal(ev[1]!.saved_input_tokens, 3000);
    assert.equal(ev[1]!.saved_cost_micro_usd, 2150);
  });

  it("bypassCache really calls the model and replaces the cached answer", async () => {
    await run("tracker.sync.events");
    const hard = await run("tracker.sync.events", { bypassCache: true, syncMode: "hard" });
    assert.equal(calls, 2);
    assert.equal(hard.cached, false);
    const after = await run("tracker.sync.events");
    assert.equal(calls, 2);
    assert.equal(after.text, hard.text); // fresh answer replaced the old entry
  });

  it("non-cacheable features are never stored and always call the model", async () => {
    const never: AiFeature[] = ["research.writer", "onboarding.verify", "research.reviewer", "tracker.followup", "tracker.timeline"];
    for (const f of never) {
      assert.equal(isCacheableFeature(f), false, f);
      await run(f);
      await run(f);
    }
    assert.equal(calls, never.length * 2);
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM ai_response_cache`).get() as { n: number }).n;
    assert.equal(n, 0);
  });

  it("policy allow-list is exactly the planned features", () => {
    const cacheable = AI_FEATURES.filter(isCacheableFeature).sort();
    assert.deepEqual(cacheable, [
      "i18n.translate",
      "research.discover",
      "research.jobfit",
      "tracker.sync.events",
      "tracker.sync.identity",
      "tracker.sync.triage",
    ]);
  });

  it("missing SDK usage → usage_missing, never zeros as truth", async () => {
    withUsage = false;
    const r = await run("research.writer");
    assert.equal(r.usage, null);
    const ev = events();
    assert.equal(ev[0]!.usage_missing, 1);
    assert.equal(ev[0]!.status, "ok");
  });

  it("different prompt / promptVersion misses the cache", async () => {
    await run("i18n.translate", { promptVersion: 1 });
    await run("i18n.translate", { promptVersion: 2 });
    await run("i18n.translate", { promptVersion: 1, prompt: "other" });
    assert.equal(calls, 3);
  });

  it("timeout still records the late usage (status timeout) and throws", async () => {
    (Agent as unknown as { prompt: unknown }).prompt = async () => {
      await new Promise((r) => setTimeout(r, 60));
      return {
        id: "r", status: "finished", result: "late",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 },
      };
    };
    await assert.rejects(run("research.writer", { timeoutMs: 10 }), /timeout/i);
    await new Promise((r) => setTimeout(r, 120));
    const ev = events();
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.status, "timeout");
    assert.equal(ev[0]!.input_tokens, 10);
  });

  it("cache TTL expiry and LRU pruning", () => {
    const put = (k: string, bytes: number, now: number) =>
      cachePut(db, { key: k, feature: "i18n.translate", model: "m", promptVersion: "1", response: "x".repeat(bytes), origInputTokens: 0, origCostMicroUsd: 0, now });
    put("a", 100, 1000);
    assert.equal(cacheGet(db, "a", 1000 + 31 * 24 * 3600 * 1000), null); // expired
    put("old", 100, 1000);
    put("new", 100, 2000);
    cacheGet(db, "old", 3000); // touch → "new" is now LRU
    cachePrune(db, 3000, 150);
    assert.ok(cacheGet(db, "old", 3001));
    assert.equal(cacheGet(db, "new", 3001), null);
    assert.equal(
      cachePut(db, { key: "w", feature: "research.writer", model: "m", promptVersion: "1", response: "r", origInputTokens: 0, origCostMicroUsd: 0 }),
      false,
    );
  });
});

/* ------------------------------------------------------------------ */
describe("anon id", () => {
  it("is created once, persists and is chmod 600", () => {
    const a = getAnonId({ root: dir, db });
    const b = getAnonId({ root: dir, db });
    assert.deepEqual(a, b);
    assert.match(a.userId, /^[0-9a-f-]{36}$/);
    assert.match(a.secret, /^[0-9a-f]{64}$/);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(anonIdPath(dir)).mode & 0o777, 0o600);
    }
  });

  it("restores from the app_meta backup when the file is missing or corrupt", () => {
    const a = getAnonId({ root: dir, db });
    fs.unlinkSync(anonIdPath(dir));
    assert.deepEqual(getAnonId({ root: dir, db }), a);
    fs.writeFileSync(anonIdPath(dir), "{not json");
    assert.deepEqual(getAnonId({ root: dir, db }), a);
    assert.deepEqual(JSON.parse(fs.readFileSync(anonIdPath(dir), "utf8")), a);
  });

  it("survives a DB wipe (file is the source of truth) and re-seeds the backup", () => {
    const a = getAnonId({ root: dir, db });
    db.prepare(`DELETE FROM app_meta`).run();
    assert.deepEqual(getAnonId({ root: dir, db }), a);
    const backup = db.prepare(`SELECT value FROM app_meta WHERE key='anon_id_backup'`).get() as { value: string };
    assert.deepEqual(JSON.parse(backup.value), a);
  });

  it("only regenerateAnonId (409 path) changes it", () => {
    const a = getAnonId({ root: dir, db });
    const b = regenerateAnonId(a.userId, { root: dir, db });
    assert.notEqual(b.userId, a.userId);
    assert.deepEqual(getAnonId({ root: dir, db }), b);
    // stale expected id → already rotated, returns current
    assert.deepEqual(regenerateAnonId(a.userId, { root: dir, db }), b);
  });
});

/* ------------------------------------------------------------------ */
describe("uploader", () => {
  const cfg = { ingestUrl: "https://example.test/ingest", anonKey: "anon" };

  function seed(n: number) {
    const backend = createDbBackend(() => db);
    for (let i = 0; i < n; i++) {
      backend.record({
        eventId: globalThis.crypto.randomUUID(),
        ts: new Date(Date.now() + i).toISOString(),
        feature: "tracker.sync.triage",
        syncMode: "incremental",
        runId: "test-sync-run",
        model: "composer-2.5",
        priceVersion: "embedded-test",
        tokens: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0, reasoningTokens: 0 },
        costMicroUsd: 42,
        durationMs: 100,
        status: "ok",
        usageMissing: false,
        cacheHit: false,
        savedInputTokens: 0,
        savedCostMicroUsd: 0,
      });
    }
  }
  const pending = () =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ai_usage_events WHERE uploaded_at IS NULL`).get() as { n: number }).n;
  const json = (status: number) => new Response("{}", { status });

  it("409: regenerates the user id, re-sends unsent rows under it, then marks them uploaded", async () => {
    seed(3);
    const original = getAnonId({ root: dir, db });
    const bodies: { user_id: string; secret: string; events: { event_id: string }[] }[] = [];
    let n = 0;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      n += 1;
      return json(n === 1 ? 409 : 200);
    }) as unknown as typeof fetch;
    const r = await uploadPending({ db, fetchImpl, config: cfg, root: dir, appVersion: "9.9.9", platform: "test" });
    assert.equal(r.status, "ok");
    assert.equal(r.sent, 3);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0]!.user_id, original.userId);
    assert.notEqual(bodies[1]!.user_id, original.userId);
    assert.notEqual(bodies[1]!.secret, original.secret);
    assert.deepEqual(
      bodies[1]!.events.map((e) => e.event_id).sort(),
      bodies[0]!.events.map((e) => e.event_id).sort(),
    );
    assert.equal(getAnonId({ root: dir, db }).userId, bodies[1]!.user_id);
    assert.equal(pending(), 0);
  });

  it("sends counters/labels only (no free-text fields)", async () => {
    seed(1);
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return json(200);
    }) as unknown as typeof fetch;
    await uploadPending({ db, fetchImpl, config: cfg, root: dir });
    assert.deepEqual(Object.keys(body).sort(), ["app_version", "events", "platform", "secret", "user_id"]);
    const ev = (body.events as Record<string, unknown>[])[0]!;
    assert.deepEqual(Object.keys(ev).sort(), [
      "cache_hit", "cache_read_tokens", "cache_write_tokens", "cost_micro_usd", "duration_ms",
      "event_id", "feature", "input_tokens", "model", "output_tokens", "price_version",
      "reasoning_tokens", "run_id", "saved_cost_micro_usd", "saved_input_tokens", "status",
      "sync_mode", "ts", "usage_missing",
    ]);
  });

  it("offline: keeps rows, backs off exponentially, never throws; retries after backoff", async () => {
    seed(2);
    let t = 1_000_000;
    const now = () => t;
    const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const r1 = await uploadPending({ db, fetchImpl: failing, config: cfg, root: dir, now });
    assert.equal(r1.status, "failed");
    assert.equal(pending(), 2);
    const first = uploaderBackoffUntil() - t;
    const r2 = await uploadPending({ db, fetchImpl: failing, config: cfg, root: dir, now });
    assert.equal(r2.status, "backoff");
    t = uploaderBackoffUntil() + 1;
    await uploadPending({ db, fetchImpl: failing, config: cfg, root: dir, now });
    assert.ok(uploaderBackoffUntil() - t >= first * 2 - 1, "backoff doubles");
    t = uploaderBackoffUntil() + 1;
    const ok = (async () => json(200)) as unknown as typeof fetch;
    const r3 = await uploadPending({ db, fetchImpl: ok, config: cfg, root: dir, now });
    assert.equal(r3.status, "ok");
    assert.equal(pending(), 0);
  });

  it("5xx keeps rows pending", async () => {
    seed(1);
    const fetchImpl = (async () => json(503)) as unknown as typeof fetch;
    const r = await uploadPending({ db, fetchImpl, config: cfg, root: dir });
    assert.equal(r.status, "failed");
    assert.equal(pending(), 1);
  });

  it("uploads even when the telemetry flag row is off, and skips only when unconfigured", async () => {
    seed(1);
    let called = 0;
    const fetchImpl = (async () => { called += 1; return json(200); }) as unknown as typeof fetch;
    assert.equal((await uploadPending({ db, fetchImpl, config: { ingestUrl: "", anonKey: "" }, root: dir })).status, "unconfigured");
    assert.equal(called, 0);
    db.prepare(`INSERT INTO settings (id, usage_telemetry_enabled) VALUES (1, 0)
                ON CONFLICT(id) DO UPDATE SET usage_telemetry_enabled = 0`).run();
    setTelemetryEnabled(false, db);
    const flag = db.prepare(`SELECT usage_telemetry_enabled AS v FROM settings WHERE id = 1`).get() as { v: number };
    assert.equal(flag.v, 1);
    db.prepare(`UPDATE settings SET usage_telemetry_enabled = 0 WHERE id = 1`).run();
    const r = await uploadPending({ db, fetchImpl, config: cfg, root: dir });
    assert.equal(r.status, "ok");
    assert.equal(called, 1);
    assert.equal(pending(), 0);
    assert.equal(
      (db.prepare(`SELECT usage_telemetry_enabled AS v FROM settings WHERE id = 1`).get() as { v: number }).v,
      1,
    );
  });
});

describe("local usage report", () => {
  function insertCall(row: {
    eventId: string;
    feature: string;
    runId: string | null;
    ts: string;
    cacheWrite?: number;
    costMicro?: number;
  }) {
    db.prepare(
      `INSERT INTO ai_usage_events (
         event_id, ts, feature, sync_mode, run_id, model, price_version,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         reasoning_tokens, cost_micro_usd, duration_ms, status, usage_missing,
         cache_hit, saved_input_tokens, saved_cost_micro_usd
       ) VALUES (?, ?, ?, NULL, ?, 'composer-2.5', 'embedded', 10, 4, 0, ?, 1, ?, 20, 'ok', 0, 0, 0, 0)`,
    ).run(row.eventId, row.ts, row.feature, row.runId, row.cacheWrite ?? 0, row.costMicro ?? 1000);
  }

  it("lists grouped runs and calls that have no run id, with every token bucket", () => {
    insertCall({
      eventId: "grouped-1",
      feature: "tracker.sync.triage",
      runId: "sync-run",
      ts: "2026-10-01T10:00:00.000Z",
    });
    insertCall({
      eventId: "solo-1",
      feature: "onboarding.verify",
      runId: null,
      ts: "2026-10-02T10:00:00.000Z",
      cacheWrite: 7,
      costMicro: 2500,
    });
    const report = buildLocalUsageReport(db, { anonRoot: dir });
    assert.equal(report.totals.calls, 2);
    assert.equal(report.totals.runs, 2);
    assert.equal(report.by_feature.length, 2);
    const verify = report.by_feature.find((f) => f.feature === "onboarding.verify");
    assert.ok(verify);
    assert.equal(verify.runs, 1);
    assert.equal(verify.cache_write_tokens, 7);
    assert.equal(report.runs.length, 2);
    assert.equal(report.runs[0]?.features[0], "onboarding.verify");
    assert.equal(report.runs[0]?.kind, "onboarding");
    assert.equal(report.runs[0]?.events.length, 1);
    assert.equal(report.runs[0]?.events[0]?.cache_write_tokens, 7);
    assert.equal(report.runs[0]?.events[0]?.saved_usd, 0);
    assert.equal(report.runs[1]?.run_id, "sync-run");
    assert.equal(report.runs[1]?.events.length, 1);
  });

  it("records imported translation usage under one run", () => {
    const n = recordImportedTranslateUsage("translate-run", [
      {
        feature: "i18n.translate",
        model: "composer-2.5",
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
        reasoningTokens: 3,
        costMicroUsd: 900,
        durationMs: 1200,
        cached: false,
        usageMissing: false,
      },
      { feature: "tracker.followup", inputTokens: 999 },
    ], db);
    assert.equal(n, 1);
    const report = buildLocalUsageReport(db, { anonRoot: dir });
    assert.equal(report.totals.calls, 1);
    assert.equal(report.runs.length, 1);
    assert.equal(report.runs[0]?.run_id, "translate-run");
    assert.equal(report.runs[0]?.kind, "translate");
    assert.equal(report.runs[0]?.events[0]?.input_tokens, 100);
    assert.equal(report.runs[0]?.events[0]?.cache_write_tokens, 2);
    assert.equal(report.runs[0]?.events[0]?.reasoning_tokens, 3);
  });
});

/* ------------------------------------------------------------------ */
describe("call coverage", () => {
  it("no direct Agent.prompt( call remains outside lib/ai-usage", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const skip = new Set(["node_modules", ".next", "dist-desktop", "desktop-pack", "desktop-resources", ".git", "docs"]);
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (skip.has(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (p === path.join(root, "lib", "ai-usage") || p === path.join(root, "test", "ai-usage")) continue;
          walk(p);
        } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) {
          const src = fs.readFileSync(p, "utf8");
          if (/\bAgent\s*\.\s*prompt\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))) {
            offenders.push(path.relative(root, p));
          }
        }
      }
    };
    walk(root);
    assert.deepEqual(offenders, []);
  });
});
