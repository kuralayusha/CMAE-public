-- Per-model usage rollups for the admin report (cmae-report). Same shape and
-- access as cmae_v_user_totals: read through the service role only.

create or replace view public.cmae_v_model_totals as
select
  coalesce(nullif(e.model, ''), 'unknown') as model,
  count(distinct e.user_id) as users,
  count(*) as calls,
  count(distinct e.run_id) filter (where e.run_id is not null) as runs,
  sum(e.input_tokens) as input_tokens,
  sum(e.output_tokens) as output_tokens,
  sum(e.cache_read_tokens) as cache_read_tokens,
  sum(e.cache_write_tokens) as cache_write_tokens,
  sum(e.reasoning_tokens) as reasoning_tokens,
  sum(e.cost_micro_usd) / 1000000::numeric as cost_usd,
  sum(e.saved_cost_micro_usd) / 1000000::numeric as saved_usd,
  count(*) filter (where e.cache_hit) as cache_hits,
  min(e.ts) as first_event_at,
  max(e.ts) as last_event_at
from public.cmae_token_events e
group by 1;

create or replace view public.cmae_v_model_features as
select
  coalesce(nullif(e.model, ''), 'unknown') as model,
  e.feature,
  count(*) as calls
from public.cmae_token_events e
group by 1, 2;

create or replace view public.cmae_v_user_models as
select
  e.user_id,
  coalesce(nullif(e.model, ''), 'unknown') as model,
  count(*) as calls
from public.cmae_token_events e
group by 1, 2;

revoke all on public.cmae_v_model_totals, public.cmae_v_model_features, public.cmae_v_user_models from anon, authenticated;
grant select on public.cmae_v_model_totals, public.cmae_v_model_features, public.cmae_v_user_models to service_role;
