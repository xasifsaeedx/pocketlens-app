-- ============================================================
-- TRANSFERS
--   Two transactions that are the same money moving between the user's own
--   accounts (e.g. -$500 out of Checking, +$500 into Savings, or a credit-card
--   payment) are not spending/income. Linking them into a "transfer group"
--   pairs the two legs and excludes both from spend/income totals.
--
--   transfer_group_id: a shared uuid on every leg of one transfer. NULL = not a
--   transfer. Linking sets the same group id on both legs and flips
--   exclude_from_totals = true; unlinking clears the group and re-includes them.
--
--   No FK/constraint enforces "exactly two legs" — the app links pairs, but the
--   shape (any number of rows sharing a group id) is intentionally permissive so
--   a future split-transfer or multi-leg case needs no migration. Match-candidate
--   detection (opposite sign, equal magnitude, nearby date, different account) is
--   a client-side PostgREST query — no server logic needed.
--
--   Shared source of truth so iOS can adopt later with no schema change.
-- ============================================================

alter table transactions add column transfer_group_id uuid;

-- Partial index: only grouped rows are queried by group (unlink, leg lookup);
-- the vast majority (NULL) stay out of the index.
create index idx_transactions_transfer_group
  on transactions(transfer_group_id)
  where transfer_group_id is not null;
