-- ============================================================
-- TAG BUDGET LIMITS + TAG SPEND VIEW
--   Monthly budget limits per TAG, mirroring the per-category `budget_limits`
--   (20260721000000) so tags get the same spent-vs-limit budgeting as categories.
--   Tags are a parallel, opt-in concept: a txn can carry a category AND tags, so
--   tag-budget totals intentionally overlap category-budget totals — this is a
--   UI/expectation matter, not a schema one.
--
--   Effective-dated exactly like budget_limits: the applicable limit for month M
--   is the row with the greatest effective_month <= M. `monthly_limit = 0`
--   explicitly marks the tag UNBUDGETED from that month onward. Clients upsert
--   onConflict: user_id,tag_id,effective_month.
--
--   Independent of ZBB: zbb_* is keyed entirely on spend categories and reads
--   category_spend; nothing here touches it.
--
--   VERSION NOTE: minted by `supabase migration new` at 2026-07-04, but that
--   version sorts BEFORE the future-hand-dated legacy files this depends on
--   (tags = 20260709, transactions/effective_date = 20260705/…, budget_limits =
--   20260721), which would break CI's fresh-DB apply. Bumped to 20260722000000,
--   the first slot past the current head (20260721000000_budget_effective_limits).
--   Prod push uses `db push --include-all`, so the out-of-real-order version
--   applies fine. Same workaround the neighboring migrations document.
-- ============================================================

create table if not exists tag_budget_limits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  tag_id uuid not null references tags(id) on delete cascade,
  effective_month date not null,              -- always the first of a month
  monthly_limit decimal(12,2) not null,       -- 0 = explicitly unbudgeted from this month onward
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tag_budget_limits_user_tag_month unique (user_id, tag_id, effective_month),
  constraint tag_budget_limits_month_is_first check (date_trunc('month', effective_month) = effective_month)
);

-- As-of lookup: newest effective_month <= target month, per (user, tag).
create index if not exists idx_tag_budget_limits_asof
  on tag_budget_limits (user_id, tag_id, effective_month desc);

alter table tag_budget_limits enable row level security;
drop policy if exists "own" on tag_budget_limits;
create policy "own" on tag_budget_limits for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- API-role grants (mirror prior migrations; implicit defaults aren't present on a fresh stack).
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on tag_budget_limits to authenticated;

-- ── Tag spend view ───────────────────────────────────────────────────
-- Spend-per-tag-per-month, the tag analogue of category_spend. Tags attach to the
-- whole parent transaction (transaction_tags.transaction_id), not to individual
-- splits — so a tagged split txn counts its FULL parent amount (the chosen policy;
-- there is no per-split tag to attribute to). Same guards as category_spend:
-- amount > 0 (spend), exclude_from_totals out (covers hidden + transfer legs),
-- pending included. security_invoker so RLS scopes each caller to their own rows.
create or replace view tag_spend with (security_invoker = true) as
select
  tt.user_id,
  (date_trunc('month', t.effective_date))::date as month,
  tt.tag_id,
  sum(t.amount) as spent
from transaction_tags tt
join transactions t on t.id = tt.transaction_id
where not t.exclude_from_totals
  and t.amount > 0
group by tt.user_id, date_trunc('month', t.effective_date), tt.tag_id;

grant select on tag_spend to authenticated;
grant select on tag_spend to service_role;
