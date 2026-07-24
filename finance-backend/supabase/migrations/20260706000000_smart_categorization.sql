-- ============================================================
-- SMARTER CATEGORIZATION
--   Old model: 4 match types (merchant/description/plaid_category/amount) + a
--   priority int the user had to reason about. Confusing and not personalized.
--
--   New model: learn from the user. When they categorize a transaction we
--   remember merchant -> category and auto-apply it to future (and, on request,
--   past) transactions from that merchant. Manual rules collapse to a single
--   keyword -> category. Priority is gone — specificity decides (exact learned
--   merchant beats a keyword rule; longest keyword wins among rules).
-- ============================================================

-- 1. Learned merchant memory (auto-filled when the user sets a category).
create table merchant_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  merchant_key text not null,          -- lowercased/trimmed merchant_name (fallback description)
  category_id uuid not null references categories(id) on delete cascade,
  updated_at timestamptz not null default now(),
  constraint merchant_categories_user_key unique (user_id, merchant_key)
);
create index idx_merchant_categories_user on merchant_categories(user_id);

alter table merchant_categories enable row level security;
create policy "own" on merchant_categories for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 2. Collapse category_rules to a plain keyword -> category. Table is empty in
--    prod, so restructure in place (no data migration).
alter table category_rules drop column if exists priority;
alter table category_rules drop column if exists match_type;
alter table category_rules drop column if exists match_value;
alter table category_rules drop column if exists merchant_pattern;
alter table category_rules add column if not exists keyword text not null default '';
