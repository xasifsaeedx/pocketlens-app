-- ============================================================
-- MULTI-USER
--   Single-user (blanket authenticated_all) -> per-user data isolation.
--   Strategy: denormalize user_id onto every user-owned table with
--   DEFAULT auth.uid() so client inserts auto-stamp the owner (no app change),
--   RLS becomes a simple indexed user_id = auth.uid() check, and the
--   service-role sync stamps user_id explicitly.
-- ============================================================

-- ── 1. Add user_id columns (nullable first, so we can backfill) ──────
alter table categories               add column user_id uuid references auth.users(id) on delete cascade;
alter table plaid_items              add column user_id uuid references auth.users(id) on delete cascade;
alter table accounts                 add column user_id uuid references auth.users(id) on delete cascade;
alter table transactions             add column user_id uuid references auth.users(id) on delete cascade;
alter table category_rules           add column user_id uuid references auth.users(id) on delete cascade;
alter table account_balance_history  add column user_id uuid references auth.users(id) on delete cascade;
alter table net_worth_snapshots      add column user_id uuid references auth.users(id) on delete cascade;
alter table budgets                  add column user_id uuid references auth.users(id) on delete cascade;
alter table separate_accounts        add column user_id uuid references auth.users(id) on delete cascade;
alter table separate_account_values  add column user_id uuid references auth.users(id) on delete cascade;
alter table recurring_contributions  add column user_id uuid references auth.users(id) on delete cascade;
alter table sync_log                 add column user_id uuid references auth.users(id) on delete cascade;

-- ── 2. Backfill existing rows to the current (single) user ───────────
do $$
declare owner uuid;
begin
  select id into owner from auth.users order by created_at limit 1;
  if owner is null then
    -- Fresh database (no users yet — a clean CI/local stack or a brand-new
    -- deployment). Nothing to backfill; but earlier migrations seed pre-multi-user
    -- rows with no user_id (e.g. the global 'Income' category from 20260701), which
    -- would violate step 3's SET NOT NULL since no owner exists. They belong to
    -- nobody, so clear them, then skip. On the real single->multi upgrade a user is
    -- always present and this whole branch is skipped.
    raise notice 'multi_user: no users — clearing orphan seed rows, skipping backfill (fresh database)';
    delete from categories              where user_id is null;
    delete from plaid_items             where user_id is null;
    delete from accounts                where user_id is null;
    delete from transactions            where user_id is null;
    delete from category_rules          where user_id is null;
    delete from account_balance_history where user_id is null;
    delete from net_worth_snapshots     where user_id is null;
    delete from budgets                 where user_id is null;
    delete from separate_accounts       where user_id is null;
    delete from separate_account_values where user_id is null;
    delete from recurring_contributions where user_id is null;
    return;
  end if;

  update categories              set user_id = owner where user_id is null;
  update plaid_items             set user_id = owner where user_id is null;
  update accounts                set user_id = owner where user_id is null;
  update transactions            set user_id = owner where user_id is null;
  update category_rules          set user_id = owner where user_id is null;
  update account_balance_history set user_id = owner where user_id is null;
  update net_worth_snapshots     set user_id = owner where user_id is null;
  update budgets                 set user_id = owner where user_id is null;
  update separate_accounts       set user_id = owner where user_id is null;
  update separate_account_values set user_id = owner where user_id is null;
  update recurring_contributions set user_id = owner where user_id is null;
  -- sync_log left as-is: existing global rows keep user_id null (not user-visible)
end $$;

-- ── 3. DEFAULT auth.uid() + NOT NULL ─────────────────────────────────
-- Default makes authenticated client inserts self-stamp the owner with no app
-- change. Service-role sync passes user_id explicitly (auth.uid() is null there).
do $$
declare t text;
begin
  foreach t in array array[
    'categories','plaid_items','accounts','transactions','category_rules',
    'account_balance_history','net_worth_snapshots','budgets',
    'separate_accounts','separate_account_values','recurring_contributions'
  ] loop
    execute format('alter table %I alter column user_id set default auth.uid()', t);
    execute format('alter table %I alter column user_id set not null', t);
  end loop;
end $$;
-- sync_log: written only by the service role; keep nullable, no default.

create index idx_categories_user            on categories(user_id);
create index idx_plaid_items_user           on plaid_items(user_id);
create index idx_accounts_user              on accounts(user_id);
create index idx_transactions_user          on transactions(user_id);
create index idx_category_rules_user        on category_rules(user_id);
create index idx_balance_history_user       on account_balance_history(user_id);
create index idx_net_worth_user             on net_worth_snapshots(user_id);
create index idx_budgets_user               on budgets(user_id);
create index idx_separate_accounts_user     on separate_accounts(user_id);
create index idx_sep_values_user            on separate_account_values(user_id);
create index idx_recurring_user             on recurring_contributions(user_id);

-- ── 4. Composite unique constraints (were single-user global) ────────
alter table net_worth_snapshots drop constraint net_worth_snapshots_date_key;
alter table net_worth_snapshots add  constraint net_worth_snapshots_user_date unique (user_id, date);

alter table budgets drop constraint unique_category_budget;
alter table budgets add  constraint budgets_user_category unique (user_id, category_id);

-- account_balance_history(account_id,date), and the Plaid global IDs
-- (plaid_item_id, plaid_account_id, plaid_transaction_id) already resolve to a
-- single user, so their unique constraints stay as-is.

-- ── 5. RLS: replace blanket policies with own-row ────────────────────
drop policy "authenticated_all" on categories;
drop policy "authenticated_all" on accounts;
drop policy "authenticated_all" on transactions;
drop policy "authenticated_all" on category_rules;
drop policy "authenticated_all" on account_balance_history;
drop policy "authenticated_all" on net_worth_snapshots;
drop policy "authenticated_all" on budgets;
drop policy "authenticated_all" on sync_log;
drop policy "authenticated_all" on separate_accounts;
drop policy "authenticated_all" on separate_account_values;
drop policy "authenticated_all" on recurring_contributions;
drop policy "authenticated_read_no_token" on plaid_items;
drop policy "no_write_from_client" on plaid_items;

do $$
declare t text;
begin
  foreach t in array array[
    'categories','accounts','transactions','category_rules',
    'account_balance_history','net_worth_snapshots','budgets',
    'separate_accounts','separate_account_values','recurring_contributions'
  ] loop
    execute format(
      'create policy "own" on %I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- plaid_items: client reads its own items only, never writes (sync service owns
-- writes via the service role). No insert/update/delete policy = blocked.
create policy "own_read" on plaid_items
  for select to authenticated using (user_id = auth.uid());

-- sync_log: user sees only its own runs; cron's global rows (user_id null) hidden.
create policy "own_read" on sync_log
  for select to authenticated using (user_id = auth.uid());

-- ── 6. Hide plaid_items.access_token from the client (column privilege) ──
-- RLS can't filter columns; the old "no_token" policy name was aspirational and
-- access_token was in fact readable. Grant only the safe columns.
revoke select on plaid_items from authenticated;
-- (institution_logo/primary_color/url come from 20260703034110_institution_logos.sql,
-- which sorts before this file on a fresh DB — they must survive this revoke.)
grant select (id, plaid_item_id, institution_id, institution_name,
              institution_logo, institution_primary_color, institution_url,
              last_synced_at, is_active, created_at, user_id)
  on plaid_items to authenticated;

-- ── 7. latest_balances: user-scoped + honor caller RLS ───────────────
drop view if exists latest_balances;
create view latest_balances with (security_invoker = true) as
select distinct on (account_id)
  account_id, user_id, current_balance, available_balance, date
from account_balance_history
order by account_id, date desc;

-- ── 8. Seed default categories for each new user ─────────────────────
create or replace function seed_default_categories()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into categories (user_id, name, color, icon, kind, sort_order) values
    (new.id, 'Groceries', '#34C759', 'cart.fill',                'spend',  0),
    (new.id, 'Dining',    '#FF9500', 'fork.knife',               'spend',  1),
    (new.id, 'Rent',      '#FF3B30', 'house.fill',               'spend',  2),
    (new.id, 'Utilities', '#5AC8FA', 'bolt.fill',                'spend',  3),
    (new.id, 'Transport', '#007AFF', 'car.fill',                 'spend',  4),
    (new.id, 'Other',     '#98989D', 'tag.fill',                 'spend', 13),
    (new.id, 'Income',    '#32D74B', 'dollarsign.circle.fill',   'income',200);
  return new;
end $$;

create trigger on_auth_user_created_seed_categories
  after insert on auth.users
  for each row execute function seed_default_categories();
