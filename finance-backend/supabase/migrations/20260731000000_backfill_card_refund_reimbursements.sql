-- ============================================================
-- BACKFILL: credit-card refunds → reimbursements (contra-expense)
--   A refund / return / statement credit on a credit-card (or loan) account is a
--   Plaid credit (amount < 0). The old sync bucketed it as INCOME, so our reported
--   spend ran higher than the bank (which treats a card refund as negative spend).
--   Going forward, categorizer._is_card_refund auto-flags these as reimbursements
--   at sync; this migration fixes the rows already stored.
--
--   Guard mirrors the sync heuristic exactly:
--     • account type ∈ (credit, loan)               — depository credits are real income
--     • amount < 0                                   — an incoming credit
--     • not exclude_from_totals / no transfer_group  — not a detected transfer leg
--     • plaid_category ∉ PFC_TRANSFER                — card payoffs carry LOAN_PAYMENTS
--
--   Two steps:
--     1. Flag the matching rows is_reimbursement = true. sumNetSpend (client) then
--        nets them off the monthly TOTAL immediately, regardless of category.
--     2. Null the mis-applied Income category on the newly-flagged rows so they do
--        NOT net into the Income category (a card refund isn't Income spend) and
--        instead re-enter the to-categorize queue for proper per-category bucketing.
--        Rows already on a real spend category (memory/rule-categorized) keep it —
--        the category_spend view nets those slices correctly.
--
--   Idempotent: step 1 skips rows already flagged; re-running changes nothing.
--
--   VERSION NOTE: hand-dated past the current head (20260730000000_group_budget_limits)
--   rather than a real `supabase migration new` "now" (2026-07-13). This migration
--   depends on transactions.is_reimbursement (added 20260720000000) and accounts.type;
--   a real-now version would sort BEFORE those and fail CI's in-order fresh-DB apply.
--   Same precedent as 20260716/20260720/20260722. Prod push uses `db push --include-all`.
--   On a fresh DB there are no rows, so both statements are no-ops.
-- ============================================================

-- 1. Flag card/loan-account refunds as reimbursements.
update transactions t
set is_reimbursement = true
from accounts a
where t.account_id = a.id
  and a.type in ('credit', 'loan')
  and t.amount < 0
  and not t.exclude_from_totals
  and t.transfer_group_id is null
  and not t.is_reimbursement
  and coalesce(t.plaid_category, '') not in ('TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS');

-- 2. Clear the old force-applied Income category on those rows so they surface in
--    the categorize queue and don't net the Income category. Keep any real spend
--    category (memory/rule) intact — the view nets those slices as intended.
update transactions t
set category_id = null
from accounts a, categories c
where t.account_id = a.id
  and a.type in ('credit', 'loan')
  and t.is_reimbursement
  and t.amount < 0
  and t.category_id = c.id
  and c.user_id = t.user_id
  and c.name = 'Income';
