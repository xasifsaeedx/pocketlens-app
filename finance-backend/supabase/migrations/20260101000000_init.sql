-- ============================================================
-- CATEGORIES
-- ============================================================
create table categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null default '#888888',
  icon text not null default 'tag',
  parent_id uuid references categories(id) on delete set null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- ============================================================
-- PLAID ITEMS
-- ============================================================
create table plaid_items (
  id uuid primary key default gen_random_uuid(),
  plaid_item_id text unique not null,
  access_token text not null,
  institution_id text,
  institution_name text,
  last_synced_at timestamptz,
  cursor text,
  is_active bool not null default true,
  created_at timestamptz not null default now()
);

-- ============================================================
-- ACCOUNTS
-- ============================================================
create table accounts (
  id uuid primary key default gen_random_uuid(),
  plaid_account_id text unique not null,
  plaid_item_id uuid references plaid_items(id) on delete cascade,
  name text not null,
  official_name text,
  type text not null,
  subtype text,
  mask text,
  currency text default 'USD',
  is_active bool not null default true,
  display_order int not null default 0,
  created_at timestamptz not null default now()
);

-- ============================================================
-- TRANSACTIONS
-- ============================================================
create table transactions (
  id uuid primary key default gen_random_uuid(),
  plaid_transaction_id text unique not null,
  account_id uuid references accounts(id) on delete cascade,
  date date not null,
  authorized_date date,
  amount decimal(12,2) not null,
  merchant_name text,
  description text,
  plaid_category text,
  category_id uuid references categories(id) on delete set null,
  notes text,
  pending bool not null default false,
  exclude_from_totals bool not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_transactions_date on transactions(date desc);
create index idx_transactions_account_id on transactions(account_id);
create index idx_transactions_category_id on transactions(category_id);

-- ============================================================
-- CATEGORY RULES
-- ============================================================
create table category_rules (
  id uuid primary key default gen_random_uuid(),
  merchant_pattern text not null,
  category_id uuid references categories(id) on delete cascade,
  priority int not null default 0,
  created_at timestamptz not null default now()
);

-- ============================================================
-- ACCOUNT BALANCE HISTORY
-- ============================================================
create table account_balance_history (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references accounts(id) on delete cascade,
  date date not null,
  current_balance decimal(12,2),
  available_balance decimal(12,2),
  constraint unique_account_date unique(account_id, date)
);

create index idx_balance_history_date on account_balance_history(date desc);

-- ============================================================
-- NET WORTH SNAPSHOTS
-- ============================================================
create table net_worth_snapshots (
  id uuid primary key default gen_random_uuid(),
  date date unique not null,
  total_assets decimal(12,2) not null default 0,
  total_liabilities decimal(12,2) not null default 0,
  net_worth decimal(12,2) generated always as (total_assets - total_liabilities) stored,
  created_at timestamptz not null default now()
);

create index idx_net_worth_date on net_worth_snapshots(date desc);

-- ============================================================
-- BUDGETS
-- ============================================================
create table budgets (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references categories(id) on delete cascade,
  monthly_limit decimal(12,2) not null,
  is_active bool not null default true,
  created_at timestamptz not null default now(),
  constraint unique_category_budget unique(category_id)
);

-- ============================================================
-- SYNC LOG
-- ============================================================
create table sync_log (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  transactions_added int default 0,
  transactions_modified int default 0,
  transactions_removed int default 0,
  accounts_updated int default 0,
  status text default 'running',
  error_message text
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table categories enable row level security;
alter table plaid_items enable row level security;
alter table accounts enable row level security;
alter table transactions enable row level security;
alter table category_rules enable row level security;
alter table account_balance_history enable row level security;
alter table net_worth_snapshots enable row level security;
alter table budgets enable row level security;
alter table sync_log enable row level security;

create policy "authenticated_all" on categories for all to authenticated using (true) with check (true);
create policy "authenticated_all" on accounts for all to authenticated using (true) with check (true);
create policy "authenticated_all" on transactions for all to authenticated using (true) with check (true);
create policy "authenticated_all" on category_rules for all to authenticated using (true) with check (true);
create policy "authenticated_all" on account_balance_history for all to authenticated using (true) with check (true);
create policy "authenticated_all" on net_worth_snapshots for all to authenticated using (true) with check (true);
create policy "authenticated_all" on budgets for all to authenticated using (true) with check (true);
create policy "authenticated_all" on sync_log for all to authenticated using (true) with check (true);

-- plaid_items: iOS app can read (not access_token column), sync service writes
create policy "authenticated_read_no_token" on plaid_items
  for select to authenticated
  using (true);

create policy "no_write_from_client" on plaid_items
  for insert to authenticated with check (false);
