-- ============================================================
-- ZERO-BASED (ZERO-SUM) BUDGETING  — WEB-15
--
--   Opt-in budgeting mode where the user gives every dollar a job:
--   set a monthly income, assign it across spend-categories until
--   Ready-to-Assign (RTA) hits 0, cover overspend by MOVING money
--   between categories, and carry balances forward month-to-month
--   (strict = carry negatives inside the category; flexible = forgive
--   the negative at category level but subtract it from RTA).
--
--   Spend-categories (categories.kind = 'spend') double as the envelopes
--   — there is NO separate envelope table. Activity (money spent) is
--   computed live from transactions on the client each load, like flat
--   budgets, so nothing to store or keep in sync. The only persisted
--   state is: settings (one row/user), per-month income, and per
--   (category, month) assigned amounts.
--
--   Flat `budgets` (per-category monthly limits) stays the default; ZBB
--   is enabled per-user via zbb_settings.enabled.
--
--   ponytail: this is the income-driven model, not the Keep reference's
--   account-liquid-pool + CC-payment-envelope machinery. Unassigned RTA
--   does NOT carry into next month (each month starts from its own income
--   + per-category rollovers). Upgrade path if users want a true running
--   cash pool: replace zbb_months.income sourcing with summed account
--   balances and carry leftover RTA forward.
-- ============================================================

-- Singleton settings row per user.
create table zbb_settings (
  id uuid primary key default gen_random_uuid(),
  enabled bool not null default false,
  rollover_mode text not null default 'strict' check (rollover_mode in ('strict', 'flexible')),
  monthly_income decimal(12,2) not null default 0,
  budget_start_year int,
  budget_start_month int check (budget_start_month between 1 and 12),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  unique (user_id)
);

-- Per-month planned income (seeded from settings.monthly_income on first touch).
create table zbb_months (
  id uuid primary key default gen_random_uuid(),
  year int not null,
  month int not null check (month between 1 and 12),
  income decimal(12,2) not null default 0,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  unique (user_id, year, month)
);
create index idx_zbb_months_user on zbb_months(user_id);

-- Per (category, month) assigned amount. category_id reuses spend categories as envelopes.
create table zbb_assignments (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references categories(id) on delete cascade,
  year int not null,
  month int not null check (month between 1 and 12),
  assigned decimal(12,2) not null default 0,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  unique (user_id, category_id, year, month)
);
create index idx_zbb_assignments_user on zbb_assignments(user_id);
create index idx_zbb_assignments_month on zbb_assignments(user_id, year, month);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table zbb_settings enable row level security;
alter table zbb_months enable row level security;
alter table zbb_assignments enable row level security;

create policy "own" on zbb_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own" on zbb_months for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own" on zbb_assignments for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================
-- ATOMIC MOVE-MONEY
--   Shift `p_amount` of ASSIGNED dollars from one category to another for
--   a month, in one transaction. Runs as security definer but is scoped to
--   the caller via auth.uid(), so RLS-equivalent isolation still holds.
-- ============================================================
create function zbb_move_money(p_year int, p_month int, p_from uuid, p_to uuid, p_amount numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if p_from = p_to then
    raise exception 'from and to categories must differ';
  end if;
  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  -- Ensure both rows exist for this month before adjusting.
  insert into zbb_assignments (category_id, year, month, assigned, user_id)
  values (p_from, p_year, p_month, 0, uid), (p_to, p_year, p_month, 0, uid)
  on conflict (user_id, category_id, year, month) do nothing;

  update zbb_assignments set assigned = assigned - p_amount
    where user_id = uid and category_id = p_from and year = p_year and month = p_month;
  update zbb_assignments set assigned = assigned + p_amount
    where user_id = uid and category_id = p_to and year = p_year and month = p_month;
end;
$$;

-- ============================================================
-- API-role grants (mirror prior migrations; implicit defaults aren't present on a fresh stack).
-- ============================================================
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on zbb_settings to authenticated;
grant select, insert, update, delete on zbb_months to authenticated;
grant select, insert, update, delete on zbb_assignments to authenticated;
grant execute on function zbb_move_money(int, int, uuid, uuid, numeric) to authenticated;
