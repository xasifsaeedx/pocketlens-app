-- Backfill: mark existing Wealthfront Cash "category" (bucket) moves as
-- one-sided self-moves so they stop counting as spend/income.
--
-- These are internal transfers between buckets INSIDE a single Plaid account
-- (Wealthfront categories aren't separate accounts). Plaid emits them as a lone
-- leg on that account, tagged with the literal token CASH_CATEGORY in the name
-- (transactions.description), e.g. "Emergency fund Withdrawal CASH_CATEGORY".
-- Going forward, sync-service/transfers.py flags them on each sync; this catches
-- rows already ingested (detect_transfers only looks back 30 days incrementally).
--
-- Mirrors the code's one-sided write shape (transfer_kind='one_sided',
-- exclude_from_totals=true, a fresh per-row transfer_group_id) and its guards:
-- skip rows the user opted out of, already-grouped rows, and hidden rows (whose
-- exclusion is already handled and whose visibility is user intent).
-- Idempotent (re-run touches nothing — the transfer_group_id IS NULL guard) and
-- fresh-DB safe (no-op on an empty transactions table).
update public.transactions
set transfer_kind = 'one_sided',
    transfer_group_id = gen_random_uuid(),
    exclude_from_totals = true
where description like '%CASH_CATEGORY%'
  and transfer_group_id is null
  and transfer_opt_out = false
  and hidden = false;
