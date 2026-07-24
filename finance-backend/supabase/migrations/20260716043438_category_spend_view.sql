-- ============================================================
-- CATEGORY SPEND VIEW
--   Single source of truth for spend-per-category-per-month. Previously both
--   clients computed this client-side and disagreed: web was splits-aware,
--   iOS ignored transaction_splits entirely (undercounting every split txn
--   in budgets + ZBB activity). Both clients now read this view.
--
--   Semantics (mirrors web categorySpend + fetchTransactions, the reference):
--     * month  = date_trunc('month', effective_date) — the column both
--       clients filter and group by (= coalesce(authorized_date, date)).
--     * A txn WITH splits contributes per split (split category + amount);
--       the parent's own category_id is ignored (the split editor nulls it,
--       but the view is defensive about legacy rows either way).
--     * A txn WITHOUT splits contributes (category_id, amount).
--     * Only positive contributions count (amount > 0 = spend), checked per
--       contribution, matching web's per-item gate.
--     * exclude_from_totals rows are out (covers hidden — setHidden keeps
--       hidden ⇒ exclude_from_totals — and transfer legs). Pending is
--       deliberately INCLUDED, same as the web month query.
--
--   security_invoker: the view runs with the caller's RLS, so authenticated
--   users only aggregate their own rows (same pattern as latest_balances).
--
--   VERSION NOTE: minted by `supabase migration new` at the real UTC instant
--   2026-07-03 04:34:38, but that version sorts BEFORE the future-hand-dated
--   legacy files this view depends on (transaction_splits = 20260710,
--   effective_date = 20260705, user_id = 20260704), which breaks CI's fresh-DB
--   apply. Date bumped to 20260716 (first slot past the legacy head
--   20260715000000); the HHMMSS keeps the real mint time for collision
--   resistance. Once real time passes 2026-07-15 this workaround is moot.
-- ============================================================

create or replace view category_spend with (security_invoker = true) as
select
  c.user_id,
  (date_trunc('month', c.effective_date))::date as month,
  c.category_id,
  sum(c.amount) as spent
from (
  -- Txns without splits: the txn's single category.
  select t.user_id, t.effective_date, t.category_id, t.amount
  from transactions t
  where not t.exclude_from_totals
    and t.category_id is not null
    and not exists (select 1 from transaction_splits s where s.transaction_id = t.id)
  union all
  -- Txns with splits: one contribution per split, attributed to the split's category.
  select t.user_id, t.effective_date, s.category_id, s.amount
  from transaction_splits s
  join transactions t on t.id = s.transaction_id
  where not t.exclude_from_totals
) c
where c.amount > 0
group by c.user_id, date_trunc('month', c.effective_date), c.category_id;

grant select on category_spend to authenticated;
grant select on category_spend to service_role;
