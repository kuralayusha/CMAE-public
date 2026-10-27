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
import { migration016OpenRouter } from "../../lib/db/migrations/016_openrouter";
import { mapPool } from "../../lib/i18n/pool";
import { fetchOpenRouterModels } from "../../lib/llm/openrouter";
import { DEFAULT_MODELS, isPlausibleModelId, slotForFeature } from "../../lib/llm/slots";

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

  it("cache write is free for the legacy composer-2.5 price row", () => {
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
    assert.equal(selectPrice(table, "composer-2.5", "2026-03-01T00:00:00Z")?.input, 0.5);
    assert.equal(selectPrice(table, "composer-2.5", "2026-07-01T00:00:00Z")?.input, 1);
    assert.equal(selectPrice(table, "other", "2026-07-01T00:00:00Z")?.input, 9);
  });

  it("unknown model has no price (never a guessed one)", () => {
    assert.equal(selectPrice(table, "nope", "2026-07-01T00:00:00Z"), null);
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
  let calls = 0;
  let withUsage = true;
  let handler: (signal: AbortSignal | null | undefined) => Promise<Response> | Response;

  const ok = (text: string, usage?: Record<string, unknown>) =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
        ...(usage ? { usage } : {}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  /** 3000 prompt tokens of which 2000 cached → 1000 uncached input. */
  const USAGE = {
    prompt_tokens: 3000,
    completion_tokens: 500,
    total_tokens: 3500,
    cost: 0.00215,
    prompt_tokens_details: { cached_tokens: 2000 },
    completion_tokens_details: { reasoning_tokens: 100 },
  };

  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    calls += 1;
    return handler(init?.signal);
  }) as typeof fetch;

  beforeEach(() => {
    calls = 0;
    withUsage = true;
    handler = () => ok(`answer-${calls}`, withUsage ? USAGE : undefined);
  });

  const run = (feature: AiFeature, extra: Record<string, unknown> = {}) =>
    promptWithUsage({
      feature,
      prompt: "some prompt",
      apiKey: "k",
      model: "test/model",
      backend: createDbBackend(() => db),
      fetchImpl,
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

  it("timeout aborts the request and records status timeout (no usage to read)", async () => {
    let aborted = false;
    handler = (signal) =>
      new Promise((_, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    await assert.rejects(run("research.writer", { timeoutMs: 10 }), /timeout/i);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(aborted, true);
    const ev = events();
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.status, "timeout");
    assert.equal(ev[0]!.usage_missing, 1);
  });

  it("a lost cancel race aborts the request and records canceled", async () => {
    let aborted = false;
    handler = (signal) =>
      new Promise((_, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const cancel = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("job canceled")), 10),
    );
    await assert.rejects(run("research.writer", { cancelRace: cancel }), /job canceled/);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(aborted, true);
    assert.equal(events()[0]!.status, "canceled");
  });

  it("reports the model and OpenRouter's own cost; BYOK adds the upstream cost", async () => {
    handler = () =>
      ok("byok", { ...USAGE, cost: 0.00005, cost_details: { upstream_inference_cost: 0.001 } });
    await run("research.writer");
    const e = events()[0]!;
    assert.equal(e.model, "test/model");
    assert.equal(e.cost_micro_usd, 1050); // 50 fee + 1000 upstream
  });

  it("normal requests report upstream cost too — it must NOT be added (dashboard parity)", async () => {
    handler = () => ok("normal", { ...USAGE, cost: 0.00215, cost_details: { upstream_inference_cost: 0.00215 } });
    await run("research.writer");
    handler = () => ok("normal2", { ...USAGE, cost: 0.002, cost_details: { upstream_inference_cost: 0.0019 } });
    await run("research.writer");
    handler = () => ok("free-byok", { ...USAGE, cost: 0, cost_details: { upstream_inference_cost: 0.001 } });
    await run("research.writer");
    assert.deepEqual(events().map((e) => e.cost_micro_usd), [2150, 2000, 1000]);
  });

  it("no reported cost → price table for known models, 0 (not a guess) for unknown", async () => {
    const noCost = { ...USAGE, cost: undefined };
    handler = () => ok("legacy", noCost);
    await run("research.writer", { model: "composer-2.5" });
    handler = () => ok("unknown", noCost);
    await run("research.writer", { model: "vendor/unpriced" });
    const [known, unknown] = events();
    assert.equal(known!.cost_micro_usd, 2150);
    assert.equal(unknown!.cost_micro_usd, 0);
    assert.equal(unknown!.usage_missing, 0); // tokens are real, only the price is unknown
    assert.equal(unknown!.input_tokens, 1000);
  });

  it("HTTP errors throw OpenRouterError, are metered as error, and 429 is retried", async () => {
    handler = () =>
      new Response(JSON.stringify({ error: { message: "No auth credentials", code: 401 } }), { status: 401 });
    await assert.rejects(run("research.writer"), /No auth credentials/);
    assert.equal(calls, 1); // 4xx is not retried
    assert.equal(events()[0]!.status, "error");

    calls = 0;
    handler = () =>
      calls === 1
        ? new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 })
        : ok("after-retry", USAGE);
    const r = await run("research.writer");
    assert.equal(r.text, "after-retry");
    assert.equal(calls, 2);
  });

  it("empty completion → emptyError, tokens still metered", async () => {
    handler = () => ok("", USAGE);
    await assert.rejects(
      run("research.writer", { emptyError: (s: string) => new Error(`empty:${s}`) }),
      /empty:/,
    );
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
describe("models: report, migration, slots", () => {
  const insert = (id: string, model: string, feature: string, cost: number, runId: string | null) =>
    db
      .prepare(
        `INSERT INTO ai_usage_events (
           event_id, ts, feature, sync_mode, run_id, model, price_version,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           reasoning_tokens, cost_micro_usd, duration_ms, status, usage_missing,
           cache_hit, saved_input_tokens, saved_cost_micro_usd
         ) VALUES (?, '2026-10-27T10:00:00.000Z', ?, NULL, ?, ?, 'p', 10, 4, 0, 0, 0, ?, 20, 'ok', 0, 0, 0, 0)`,
      )
      .run(id, feature, runId, model, cost);

  it("report breaks spend down by model, with the features each served", () => {
    insert("a", "anthropic/claude-haiku-5.5", "tracker.sync.triage", 100, "r1");
    insert("b", "anthropic/claude-haiku-5.5", "i18n.translate", 50, "r2");
    insert("c", "anthropic/claude-sonnet-5.5", "research.writer", 900, "r1");
    const report = buildLocalUsageReport(db, { anonRoot: dir });
    assert.deepEqual(
      report.by_model.map((m) => [m.model, m.calls, m.cost_usd]),
      [
        ["anthropic/claude-sonnet-5.5", 1, 0.0009],
        ["anthropic/claude-haiku-5.5", 2, 0.00015],
      ],
    );
    assert.deepEqual(report.by_model[0]!.features, ["research.writer"]);
    const run1 = report.runs.find((r) => r.run_id === "r1")!;
    assert.deepEqual([...run1.models].sort(), [
      "anthropic/claude-haiku-5.5",
      "anthropic/claude-sonnet-5.5",
    ]);
  });

  it("migration 016 labels old rows composer-2.5 and drops the Cursor secret", () => {
    insert("old", "", "research.writer", 10, null);
    insert("new", "x/y", "research.writer", 10, null);
    db.prepare(`INSERT OR IGNORE INTO settings (id) VALUES (1)`).run();
    db.prepare(`UPDATE settings SET cursor_api_key_enc = 'secret' WHERE id = 1`).run();
    migration016OpenRouter.up(db); // idempotent re-run
    const models = db.prepare(`SELECT event_id, model FROM ai_usage_events ORDER BY event_id`).all();
    assert.deepEqual(models, [
      { event_id: "new", model: "x/y" },
      { event_id: "old", model: "composer-2.5" },
    ]);
    const row = db.prepare(`SELECT cursor_api_key_enc AS k FROM settings WHERE id = 1`).get() as { k: string | null };
    assert.equal(row.k, null);
  });

  it("slots: writing/judgement is smart, bulk structured work is fast", () => {
    for (const f of AI_FEATURES) {
      const smart = ["research.research", "research.writer", "research.reviewer", "research.jobfit", "tracker.followup"];
      assert.equal(slotForFeature(f), smart.includes(f) ? "smart" : "fast", f);
    }
    assert.ok(isPlausibleModelId(DEFAULT_MODELS.fast));
    assert.ok(isPlausibleModelId(DEFAULT_MODELS.smart));
    assert.ok(isPlausibleModelId("google/gemini-3.7-flash:free"));
    for (const bad of ["", "gpt", "a/b c", "../x/y", 5, null]) assert.equal(isPlausibleModelId(bad), false, String(bad));
  });

  it("catalog parsing: text models only, $/1M prices, free flag", async () => {
    const body = {
      data: [
        { id: "b/paid", name: "Paid", context_length: 1000, architecture: { output_modalities: ["text"] }, pricing: { prompt: "0.000001", completion: "0.000005" } },
        { id: "a/free:free", name: "Free", architecture: { output_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" } },
        { id: "c/image", name: "Img", architecture: { output_modalities: ["image"] }, pricing: { prompt: "0.1", completion: "0.1" } },
      ],
    };
    const f = (async () => new Response(JSON.stringify(body))) as typeof fetch;
    const models = await fetchOpenRouterModels(f);
    assert.deepEqual(models.map((m) => m.id), ["a/free:free", "b/paid"]);
    assert.equal(models[1]!.promptPerM, 1);
    assert.equal(models[1]!.completionPerM, 5);
    assert.equal(models[0]!.free, true);
    assert.equal(models[1]!.free, false);
  });
});

/* ------------------------------------------------------------------ */
describe("mapPool (parallel translation)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("keeps input order, never exceeds the limit, and actually overlaps", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapPool([30, 5, 20, 1, 10, 2], 3, async (ms, i) => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(ms);
      active -= 1;
      return `r${i}`;
    });
    assert.deepEqual(out, ["r0", "r1", "r2", "r3", "r4", "r5"]);
    assert.equal(peak, 3);
  });

  it("on failure starts nothing new, but waits for in-flight work, then throws the first error", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    await assert.rejects(
      mapPool([0, 1, 2, 3, 4, 5], 2, async (_, i) => {
        started.push(i);
        if (i === 0) throw new Error("boom");
        await sleep(30);
        finished.push(i);
      }),
      /boom/,
    );
    assert.ok(started.length < 6, "stopped launching new items");
    assert.deepEqual([...finished].sort(), started.filter((i) => i !== 0).sort(), "in-flight items completed");
  });

  it("handles empty input and limit larger than the list", async () => {
    assert.deepEqual(await mapPool([], 5, async () => 1), []);
    assert.deepEqual(await mapPool([1, 2], 50, async (n) => n * 2), [2, 4]);
  });
});

/* ------------------------------------------------------------------ */
describe("call coverage", () => {
  it("model API is only reached through lib/ai-usage + lib/llm; the Cursor SDK is gone", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const skip = new Set(["node_modules", ".next", "dist-desktop", "desktop-pack", "desktop-resources", ".git", "docs"]);
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (skip.has(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if ([path.join(root, "lib", "ai-usage"), path.join(root, "lib", "llm"), path.join(root, "test", "ai-usage")].includes(p)) continue;
          walk(p);
        } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) {
          const src = fs.readFileSync(p, "utf8");
          if (/@cursor\/sdk|\bopenRouterChat\s*\(|openrouter\.ai\/api\/v1\/chat/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))) {
            offenders.push(path.relative(root, p));
          }
        }
      }
    };
    walk(root);
    assert.deepEqual(offenders, []);
  });
});
