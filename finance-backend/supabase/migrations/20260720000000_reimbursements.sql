-- ============================================================
-- REIMBURSEMENTS (contra-expense)
--   A reimbursement is an incoming credit (amount < 0) that OFFSETS spending in a
--   category — e.g. a roommate Zelles you back your half of rent. It is NOT income:
--   it reduces that category's net spend and stays out of the income total.
--
--   Model: a plain transaction flagged `is_reimbursement = true`, with a category_id
--   (the category it offsets) and amount < 0. It is NOT exclude_from_totals — it must
--   remain visible to the category_spend view so it can net.
--
--   This migration:
--     1. adds transactions.is_reimbursement (default false — every existing row is a
--        normal txn, so the view result is unchanged until a row is flagged);
--     2. redefines the category_spend view so per-category spend nets reimbursements:
--        spent = Σ(positive spend, splits-aware) − Σ(reimbursement credit magnitudes).
--        Budgets, ZBB, and Reports all read this view, so they net automatically.
--        (Clients also exclude reimbursements from the income total + the
--        to-categorize queue — that part is client-side.)
--
--   VERSION NOTE: like 20260716043438_category_spend_view.sql, this must sort AFTER its
--   dependencies (transactions, transaction_splits=20260710, the original view=20260716)
--   or CI's in-order fresh-DB apply recreates the view before its deps exist. The real
--   `supabase migration new` mint time (2026-07-04) sorts BEFORE the future-hand-dated
--   legacy files, so the version is bumped to 20260720000000 — the first slot past the
--   current head (20260719163154). Prod push uses `db push --include-all`, so the
--   out-of-real-order version applies fine. Once real time passes 2026-07-20 this is moot.
-- ============================================================

alter table transactions
  add column if not exists is_reimbursement boolean not null default false;

-- Reimbursements are credits that offset a category, so they must carry a category_id
-- but never nag the to-categorize queue (clients filter is_reimbursement out there too).
create index if not exists idx_transactions_reimbursement
  on transactions (user_id) where is_reimbursement;

-- Redefine category_spend to net reimbursements. Identical to 20260716 for normal spend
-- (splits-aware, positive-only, excludes exclude_from_totals, includes pending) plus a
-- third branch that folds reimbursement credits (negative) into their category.
create or replace view category_spend with (security_invoker = true) as
select
  c.user_id,
  (date_trunc('month', c.effective_date))::date as month,
  c.category_id,
  sum(c.amount) as spent
from (
  -- Normal txns without splits: the txn's single category, positive spend only.
  select t.user_id, t.effective_date, t.category_id, t.amount
  from transactions t
  where not t.exclude_from_totals
    and t.category_id is not null
    and not t.is_reimbursement
    and t.amount > 0
    and not exists (select 1 from transaction_splits s where s.transaction_id = t.id)
  union all
  -- Split contributions (parent is a normal txn): per split category, positive only.
  select t.user_id, t.effective_date, s.category_id, s.amount
  from transaction_splits s
  join transactions t on t.id = s.transaction_id
  where not t.exclude_from_totals
    and not t.is_reimbursement
    and s.amount > 0
  union all
  -- Reimbursement credits: negative amount folded into the offset category (nets spend).
  select t.user_id, t.effective_date, t.category_id, t.amount
  from transactions t
  where not t.exclude_from_totals
    and t.category_id is not null
    and t.is_reimbursement
    and t.amount < 0
) c
group by c.user_id, date_trunc('month', c.effective_date), c.category_id;

grant select on category_spend to authenticated;
grant select on category_spend to service_role;
