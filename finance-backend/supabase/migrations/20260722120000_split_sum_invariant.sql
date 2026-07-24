-- ============================================================
-- SPLIT-SUM INVARIANT
--   When a transaction has splits, they must sum to the transaction amount.
--   Previously "enforced in the app" only (the split editor requires
--   remainder = 0). That left the money math trusting the client: any editor
--   that wrote legs summing to LESS than the parent silently undercounted the
--   txn's spend in category_spend / budgets / ZBB, with nothing — client,
--   server view, or DB — to catch it.
--
--   This adds a DEFERRABLE INITIALLY DEFERRED constraint trigger so the check
--   runs once per transaction at COMMIT, not per row. That is important because
--   the client rewrites splits as delete-all + re-insert; a per-row immediate
--   trigger would fire on the transient (empty / half-inserted) state.
--
--   Scope is deliberately transaction_splits ONLY. It never fires on
--   transactions.amount updates, so a Plaid `modified` amount change on an
--   already-split txn cannot make sync throw. Sync instead clears now-stale
--   splits in its modify path (finance-backend/sync-service/sync.py), mirroring
--   how it unlinks auto-transfers whose amount changed.
--
--   Note: creating the trigger does NOT validate pre-existing rows; any legacy
--   imbalance is caught the next time that txn's splits are written.
--
--   Re-touched to re-trigger db-push: its first CircleCI apply timed out on an
--   interactive [Y/n] prompt (missing --yes) before this migration reached prod,
--   so it stayed pending on remote history — this edit makes the merge's db-push
--   pick it up again. Safe to edit: it never applied to prod, and remote
--   schema_migrations keys by version only.
--
--   Version: hand-dated past the current head (20260722000000_tag_budget_limits).
--   This migration depends on transaction_splits (created 20260710) and the
--   legacy migrations are fake-dated into 2026-07-2x, so a real "now" timestamp
--   (2026-07-05) would sort BEFORE the table and fail on a fresh-DB apply — same
--   precedent as category_spend / zbb_month_overview above.
-- ============================================================

create or replace function assert_split_sum() returns trigger
  language plpgsql as $$
declare
  txn_id uuid := coalesce(new.transaction_id, old.transaction_id);
  parent numeric;
  legs   numeric;
begin
  select amount into parent from transactions where id = txn_id;
  -- Parent gone (txn deleted → splits cascade-removed): nothing to check.
  if parent is null then
    return null;
  end if;
  -- No splits left: the txn is single-category again, invariant N/A.
  if not exists (select 1 from transaction_splits where transaction_id = txn_id) then
    return null;
  end if;
  select coalesce(sum(amount), 0) into legs
    from transaction_splits where transaction_id = txn_id;
  if round(legs, 2) <> round(parent, 2) then
    raise exception
      'transaction % splits sum to % but its amount is %', txn_id, legs, parent
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

drop trigger if exists split_sum_balanced on transaction_splits;
create constraint trigger split_sum_balanced
  after insert or update or delete on transaction_splits
  deferrable initially deferred
  for each row execute function assert_split_sum();
