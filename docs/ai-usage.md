# AI usage metering, response cache, telemetry

All model calls go through `promptWithUsage` (`lib/ai-usage/call.ts`) — the only
place that talks to the model API (one OpenRouter `chat/completions` request via
`lib/llm/openrouter.ts`; enforced by `test/ai-usage`). Every caller passes an
explicit `feature` label (`lib/ai-usage/features.ts`) and an explicit `model`.

## Provider and models
OpenRouter only. Two user-configurable slots (Settings → AI, and the onboarding
AI step), mapped from `feature` by `slotForFeature` (`lib/llm/slots.ts`):
- **fast** — tracker sync (triage / identity / events), signals, match,
  timeline, scout, link planning (`research.discover`), translation, key check.
- **smart** — `research.research`, `research.writer`, `research.reviewer`,
  `research.jobfit`, `tracker.followup`.

`settings.llm_model_fast|smart` store the slug only when it differs from
`DEFAULT_MODELS`, so changing the defaults still reaches users who never
customised. `lib/llm/config.ts` resolves key + model: env `OPENROUTER_API_KEY`
first, then the user's key from Settings. The Vercel translation host has no
per-user DB: it only uses env — `OPENROUTER_API_KEY` (the maintainer's admin
key, which pays for language packs) and optionally `CMAE_I18N_MODEL`,
`CMAE_LLM_MODEL_FAST|SMART`.

A user who wants Gemini (or any provider's own key) adds it in their OpenRouter
account (Settings → Integrations, "BYOK"); CMAE never sees or sends it. OpenRouter
then routes to that key and charges a small fee (first 1M BYOK requests/month free).

## Reading usage
OpenRouter returns `usage` on every response (no opt-in). Mapping to our schema
(kept from the Cursor era so old and new rows add up):
- `inputTokens` = `prompt_tokens − cached_tokens − cache_write_tokens` (uncached).
- `cacheReadTokens` = `prompt_tokens_details.cached_tokens`; `cacheWriteTokens` =
  `prompt_tokens_details.cache_write_tokens` (only models with explicit caching).
- `outputTokens` = `completion_tokens`; `reasoningTokens` ⊂ output.
- Absent `usage` → `usage_missing = 1` (never zeros as truth). An aborted
  request (timeout / cancel) has no usage: it is recorded as `timeout` /
  `canceled` with `usage_missing = 1`.

## Cost
`cost_micro_usd` = `round(usage.cost × 1e6)` — what OpenRouter charged the
account, i.e. exactly what its dashboard sums. Normal requests also carry
`cost_details.upstream_inference_cost` (≈ `cost`): adding it double-counts
(a 20-call translation first showed $0.083 vs the dashboard's $0.0415). Only for
a BYOK request (upstream > 2 × cost: `cost` is just OpenRouter's ~5% fee, or 0
inside the free allowance) the two are separate bills, so upstream is added
(`openRouterCostUsd` in `call.ts`; OpenRouter's docs example: cost 0.95 = 5% of
upstream 19). If a response has no `cost`, the price table (`pricing.ts`) is a
fallback for known models; an unknown model gets cost 0 with its tokens kept —
never a guessed price. The remote table (`CMAE_USAGE_PRICES_URL`, refreshed
daily, cached in `app_meta.ai_prices_json`) only matters for that fallback and
for pre-OpenRouter `composer-2.5` rows.

## Local store (migrations `012_ai_usage`, `014_ai_usage_run_id`, `016_openrouter`)
- `ai_usage_events`: counters + labels only, doubles as the upload queue
  (`uploaded_at`). `model` is the OpenRouter slug. Migration 016 labels rows
  with an empty model `composer-2.5` (everything before OpenRouter).
  `run_id` groups many LLM calls into one UI-level run (sync job id, research
  job id, or a translate-batch UUID). Kept across account switch; removed only
  by a full wipe.
- `ai_response_cache`: key = sha256(model | feature | prompt_version |
  normalized prompt) — switching a model never serves another model's answer.
  Cached features: `tracker.sync.{triage,identity,events}`, `i18n.translate`,
  `research.{discover,jobfit}`. Never: `research.writer`, drafts,
  `onboarding.verify`, followup/timeline/match. TTL 30 days, ~50 MB LRU.
  Hard sync passes `bypassCache`. Wiped on account switch / onboarding wipe;
  never uploaded.

## Anonymous id
`<userData>/anon-id` = `{userId (uuidv4), secret (32 random bytes hex)}`, chmod
600, written once (exclusive link), backup in `app_meta.anon_id_backup`. Survives
onboarding wipe/account switch; only the server's `409` (id collision) path
regenerates it (`regenerateAnonId`) and unsent rows are re-sent under the new id.

## Upload (`lib/ai-usage/uploader.ts`)
Every ~60 s (or 50 new rows): `POST CMAE_USAGE_INGEST_URL` with headers
`apikey`/`Authorization: Bearer CMAE_USAGE_ANON_KEY` and body
`{user_id, secret, app_version, platform, events[]}`; `event_id` (uuid) makes
re-sends idempotent. Each event already carries `model`, so the wire format did
not change for OpenRouter. Exponential backoff offline (1 min → 1 h). Skipped
when telemetry is off or the URL is unset. No text is ever sent. Env:
`CMAE_USAGE_INGEST_URL`, `CMAE_USAGE_ANON_KEY`, `CMAE_USAGE_PRICES_URL`.

## Usage page
`/usage` always shows **this machine's** local `ai_usage_events` (KPIs, **by
model**, by feature, recent runs with the models each run used) via
`GET /api/usage-report` — no report secret needed. When
`CMAE_USAGE_REPORT_SECRET` is set the same page can open an admin view
(`?admin=1`) that proxies the Supabase Edge Function `cmae-report`.

### Supabase side (not in this repo)
The admin view renders whatever `cmae-report` returns. For per-model reporting
the function should add (all optional — the UI hides what is missing):
- `grand.by_model`: `[{model, calls, runs, input_tokens, output_tokens,
  cache_read_tokens, cost_usd, features[]}]` across all users;
- `users[].models`: distinct model slugs per user;
- per-user detail: `by_model` (same row shape) and `runs[].models`.
`GROUP BY model` over the existing `ai_usage_events.model` column is enough.
Backfill rows ingested before the migration:
`update ai_usage_events set model = 'composer-2.5' where model is null or model = '';`

## Tests
`npm run test:ai-usage`; eval: `CMAE_EVAL_MODEL=<slug> node --import tsx test/tracker-eval/run-eval.ts`
(needs `OPENROUTER_API_KEY`; the eval cache is keyed by model + prompt).
