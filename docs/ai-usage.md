# AI usage metering, response cache, telemetry

All model calls go through `promptWithUsage` (`lib/ai-usage/call.ts`) — the only
place that calls `Agent.prompt` (enforced by `test/ai-usage`). Every caller passes
an explicit `feature` label (`lib/ai-usage/features.ts`).

## Reading usage from the SDK
`Agent.prompt` = create → send → wait → dispose; `run.wait()` returns a
`RunResult` whose `usage?: TokenUsage` (`inputTokens, outputTokens,
cacheReadTokens, cacheWriteTokens, reasoningTokens?`) is read directly. Absent →
`usage_missing = 1` (never zeros as truth). `inputTokens` is the uncached bucket,
`cacheReadTokens` separate, `reasoningTokens` ⊂ `outputTokens` (not billed twice).

## Cost
`lib/ai-usage/pricing.ts`: USD per 1M tokens (= micro-USD per token) →
integer micro-USD. Embedded Composer 2.5: input 0.50, cache read 0.20, output
2.50, cache write 0. A remote table (`CMAE_USAGE_PRICES_URL`, refreshed daily,
cached in `app_meta.ai_prices_json`) overrides it; `price_version` is stored per
row so old rows keep the price of their day.

## Local store (migration `012_ai_usage`)
- `ai_usage_events`: counters + labels only, doubles as the upload queue
  (`uploaded_at`). Kept across account switch; removed only by a full wipe.
- `ai_response_cache`: key = sha256(model | feature | prompt_version |
  normalized prompt). Cached features: `tracker.sync.{triage,identity,events}`,
  `i18n.translate`, `research.{discover,jobfit}`. Never: `research.writer`,
  drafts, `onboarding.verify`, followup/timeline/match. TTL 30 days, ~50 MB LRU.
  Hard sync passes `bypassCache` (fresh answer replaces the entry). Wiped on
  account switch / onboarding wipe (contains mail-derived text); never uploaded.

## Anonymous id
`<userData>/anon-id` = `{userId (uuidv4), secret (32 random bytes hex)}`, chmod
600, written once (exclusive link), backup in `app_meta.anon_id_backup`. Survives
onboarding wipe/account switch; only the server's `409` (id collision) path
regenerates it (`regenerateAnonId`) and unsent rows are re-sent under the new id.

## Upload (`lib/ai-usage/uploader.ts`)
Every ~60 s (or 50 new rows): `POST CMAE_USAGE_INGEST_URL` with headers
`apikey`/`Authorization: Bearer CMAE_USAGE_ANON_KEY` and body
`{user_id, secret, app_version, platform, events[]}`; `event_id` (uuid) makes
re-sends idempotent. Exponential backoff offline (1 min → 1 h). Skipped when
telemetry is off (Settings → Privacy, default on) or the URL is unset. No text is
ever sent. Env: `CMAE_USAGE_INGEST_URL`, `CMAE_USAGE_ANON_KEY`,
`CMAE_USAGE_PRICES_URL` (or the embedded defaults in `lib/ai-usage/config.ts`).

## Tests
`npm run test:ai-usage`; eval: `node --import tsx test/tracker-eval/run-eval.ts`.
