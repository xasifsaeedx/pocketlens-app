-- ============================================================
-- CATEGORIES: kind (spend vs income) — income hidden from Budget
-- ============================================================
alter table categories add column kind text not null default 'spend';

insert into categories (name, color, icon, sort_order, kind)
values ('Income', '#32D74B', 'dollarsign.circle.fill', 200, 'income');

-- ============================================================
-- CATEGORY RULES: richer match model
--   match_type ∈ merchant_contains | description_contains
--                | plaid_category_is | amount_direction
--   match_value: the text/category/'in'|'out' to match
-- ============================================================
alter table category_rules add column match_type text not null default 'merchant_contains';
alter table category_rules add column match_value text;
update category_rules set match_value = merchant_pattern where match_value is null;

-- ============================================================
-- SEPARATE ACCOUNTS (manual, non-Plaid)
-- ============================================================
create table separate_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null default 'other',   -- depository|investment|other = asset; credit|loan = liability
  currency text default 'USD',
  is_active bool not null default true,
  display_order int not null default 0,
  created_at timestamptz not null default now()
);

-- Ledger of signed deltas; balance = sum(amount). Multiple entries per day allowed.
create table separate_account_values (
  id uuid primary key default gen_random_uuid(),
  separate_account_id uuid references separate_accounts(id) on delete cascade,
  date date not null,
  amount decimal(12,2) not null,
  note text,
  created_at timestamptz not null default now()
);

create index idx_sep_values_account on separate_account_values(separate_account_id);
create index idx_sep_values_date on separate_account_values(date desc);

-- Recurring Contribution: fixed delta applied every frequency_in_days.
create table recurring_contributions (
  id uuid primary key default gen_random_uuid(),
  separate_account_id uuid references separate_accounts(id) on delete cascade,
  delta_balance decimal(12,2) not null,
  frequency_in_days int not null,
  anchor_date date not null,
  last_applied_date date,
  is_active bool not null default true,
  created_at timestamptz not null default now()
);

create index idx_recurring_account on recurring_contributions(separate_account_id);

-- ============================================================
-- ROW LEVEL SECURITY (mirror init.sql blanket authenticated_all)
-- ============================================================
alter table separate_accounts enable row level security;
alter table separate_account_values enable row level security;
alter table recurring_contributions enable row level security;

create policy "authenticated_all" on separate_accounts for all to authenticated using (true) with check (true);
create policy "authenticated_all" on separate_account_values for all to authenticated using (true) with check (true);
create policy "authenticated_all" on recurring_contributions for all to authenticated using (true) with check (true);
