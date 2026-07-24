-- ============================================================
-- GROUP BUDGET LIMITS
--   Monthly budget limits per CATEGORY GROUP, mirroring budget_limits
--   (20260721000000) so groups get the same effective-dated spent-vs-limit
--   budgeting as individual categories.
--
--   A group limit is a ceiling over the group as a whole — it is independent of
--   the per-category limits inside the group. The rules clients enforce:
--     1. All categories in the group have a budget → auto-suggest sum, user may
--        raise it freely.
--     2. Some (not all) categories have a budget → group limit must be >= sum of
--        the budgeted categories' limits.
--     3. No categories are budgeted → free entry, no floor.
--   These constraints are client-side; the DB stores only the value.
--
--   Effective-dated identically to budget_limits:
--     • The applicable limit for month M = row with greatest effective_month <= M.
--     • monthly_limit = 0 = explicitly unbudgeted sentinel (prevents an older
--       positive row resurfacing after the user removes a budget).
--   Clients upsert with onConflict: user_id,group_id,effective_month.
--
--   Deleting a category_group cascades here (ON DELETE CASCADE on group_id).
-- ============================================================

create table if not exists group_budget_limits (
  id               uuid          primary key default gen_random_uuid(),
  user_id          uuid          not null references auth.users(id) on delete cascade default auth.uid(),
  group_id         uuid          not null references category_groups(id) on delete cascade,
  effective_month  date          not null,          -- always the first of a month
  monthly_limit    decimal(12,2) not null,           -- 0 = explicitly unbudgeted sentinel
  created_at       timestamptz   not null default now(),
  updated_at       timestamptz   not null default now(),

  constraint group_budget_limits_user_group_month
    unique (user_id, group_id, effective_month),
  constraint group_budget_limits_month_is_first
    check (date_trunc('month', effective_month) = effective_month)
);

-- As-of lookup index: newest effective_month <= target month, per (user, group).
create index if not exists idx_group_budget_limits_asof
  on group_budget_limits (user_id, group_id, effective_month desc);

alter table group_budget_limits enable row level security;

drop policy if exists "own" on group_budget_limits;
create policy "own" on group_budget_limits
  for all to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

-- API-role grants (mirror every other user-owned table).
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on group_budget_limits to authenticated;
