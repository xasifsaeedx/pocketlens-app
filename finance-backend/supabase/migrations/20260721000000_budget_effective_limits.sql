-- ============================================================
-- EFFECTIVE-DATED BUDGET LIMITS
--   Per-category monthly limits become effective-dated: instead of one flat row
--   per category (the legacy `budgets` table), each change is recorded as a row
--   keyed by (category_id, effective_month). The applicable limit for any month M
--   is the row with the greatest effective_month <= M (an "as-of" lookup).
--
--   `monthly_limit = 0` is meaningful: it explicitly marks the category as
--   UNBUDGETED from that month onward (distinct from "no row yet" = inherit the
--   prior effective limit / the 2020-01 backfill seed).
--
--   Clients upsert with onConflict: user_id,category_id,effective_month.
--   `budgets` is left in place (now dormant/legacy) — this table is the source of
--   truth for per-category monthly limits going forward.
--
--   VERSION NOTE: hand-dated 20260721000000 — the first slot past the current head
--   (20260720000000_reimbursements). The real `supabase migration new` mint time
--   (2026-07-04) would sort BEFORE the future-hand-dated legacy files, so the
--   version is bumped forward. Prod push uses `db push --include-all`, so the
--   out-of-real-order version applies fine.
-- ============================================================

create table if not exists budget_limits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  category_id uuid not null references categories(id) on delete cascade,
  effective_month date not null,              -- always the first of a month
  monthly_limit decimal(12,2) not null,       -- 0 = explicitly unbudgeted from this month onward
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budget_limits_user_category_month unique (user_id, category_id, effective_month),
  constraint budget_limits_month_is_first check (date_trunc('month', effective_month) = effective_month)
);

-- As-of lookup: newest effective_month <= target month, per (user, category).
create index if not exists idx_budget_limits_asof
  on budget_limits (user_id, category_id, effective_month desc);

alter table budget_limits enable row level security;
drop policy if exists "own" on budget_limits;
create policy "own" on budget_limits for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- API-role grants (mirror prior migrations; implicit defaults aren't present on a fresh stack).
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on budget_limits to authenticated;

-- ── Backfill ─────────────────────────────────────────────────────────
-- Seed existing active budgets as effective from 2020-01-01 so they apply to all
-- past months until a later change is recorded. On a fresh DB `budgets` is empty,
-- so this is a no-op. Idempotent via the unique-constraint conflict guard.
insert into budget_limits (user_id, category_id, effective_month, monthly_limit)
select user_id, category_id, date '2020-01-01', monthly_limit
from budgets
where is_active = true and category_id is not null
on conflict (user_id, category_id, effective_month) do nothing;
