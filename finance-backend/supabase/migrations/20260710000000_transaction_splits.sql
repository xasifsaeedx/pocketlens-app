-- ============================================================
-- TRANSACTION SPLITS
--   One transaction can be divided across several categories (e.g. a Target
--   run that is part Groceries, part Household). When a txn has splits,
--   spend/budget reporting attributes each split to its own category instead
--   of the single transactions.category_id.
--
--   Sum of a txn's split amounts must equal the txn amount — enforced in the
--   app (the split editor requires remainder = 0), not a trigger (YAGNI: the
--   only writer is the client, and a trigger can't see the parent amount
--   cheaply without a lookup on every row write).
--
--   Shared source of truth so iOS can adopt later with no schema change.
-- ============================================================

create table transaction_splits (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  amount numeric not null,             -- same sign convention as transactions (+ = spend)
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid()
);
create index idx_transaction_splits_txn on transaction_splits(transaction_id);
create index idx_transaction_splits_user on transaction_splits(user_id);

alter table transaction_splits enable row level security;
create policy "own" on transaction_splits for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- API-role grants (mirror prior migrations; implicit defaults aren't present on a fresh stack).
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on transaction_splits to authenticated;
