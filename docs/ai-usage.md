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

**Translate endpoint limits** (`POST /api/i18n/translate`, public on the host
that holds the key; helpers in `lib/i18n/translate-guard.ts`):
- Body ≤ 1 KiB, a JSON object with ≤ 4 keys; only `targetLanguage` is read →
  otherwise `413` / `400` with `{ "error": "..." }`.
- `targetLanguage` must be a BCP-47-like tag (`tr`, `pt-BR`, `zh-Hant`, ≤ 16
  chars) whose primary subtag is one of the UI languages in
  `lib/settings/languages.ts` → otherwise `400`.
- On the Vercel host: 10 requests per IP per hour (sliding window) → `429` with
  `Retry-After`. The limiter is in-memory, and serverless instances do not share
  memory, so it is only a speed bump; use Vercel WAF rate limiting or a shared
  store such as Upstash for a real limit.

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

## Local store (migrations `012_ai_usage`, `014_ai_usage_run_id`, `017_openrouter`)
- `ai_usage_events`: counters + labels only, doubles as the upload queue
  (`uploaded_at`). `model` is the OpenRouter slug. Migration 017 labels rows
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

### Supabase side (`supabase/`)
Project `your-project-ref` ("example-project"). The deployed Edge Functions
are versioned in `supabase/functions/` — `cmae-ingest` (POST, per-user secret
hash), `cmae-report` (admin, secret hash in table `cmae_report_auth`),
`cmae-prices`. All three run with JWT verification off (the functions do their
own auth). Deploy with the Supabase CLI from `supabase/`, keeping that flag:
`supabase functions deploy cmae-report --project-ref your-project-ref --no-verify-jwt --use-api`.

Model breakdown (admin view): `cmae-report` returns `grand.by_model`,
`users[].models`, and per-user `by_model` + `runs[].models`. The overview reads
three GROUP BY views from `supabase/migrations/20261027000000_model_views.sql`
(`cmae_v_model_totals`, `cmae_v_model_features`, `cmae_v_user_models`; service
role only, like `cmae_v_user_totals`) so it is exact at any table size. If the
views are missing it falls back to scanning up to 50 000 events and sets
`grand.by_model_truncated` when that cap is hit; `grand.by_model_source` says
which path ran. Run SQL with `npx supabase@latest db query --linked
--project-ref … --file …` (the CLI 2.72 installed here has no `db query`).

`model` was already part of the ingest wire format, and `cmae-ingest` accepts
OpenRouter slugs (`vendor/model:variant`) via `MODEL_RE`; every row ingested
before OpenRouter is labelled `composer-2.5`, so no backfill is needed.

## Tests
`npm run test:ai-usage`.
