-- ============================================================
-- TRANSFER AUTO-DETECTION
--   The sync service now links transfer legs automatically (see
--   sync-service/transfers.py): two posted transactions with opposite/equal
--   amounts in different accounts within a few days, where at least one leg
--   carries a Plaid transfer signal (personal_finance_category primary of
--   TRANSFER_IN / TRANSFER_OUT / LOAN_PAYMENTS), get a shared
--   transfer_group_id and exclude_from_totals = true — same shape the manual
--   web linking (20260711000000_transfers.sql) already writes.
--
--   transfer_kind: provenance of the group.
--     'auto'      — sync-detected pair
--     'manual'    — user-linked (or user-confirmed suggestion)
--     'one_sided' — single-leg group: Plaid says transfer but the counterpart
--                   account isn't connected (e.g. a Robinhood deposit). Still
--                   excluded from totals; upgraded in place to an 'auto' pair
--                   if the other leg ever syncs.
--
--   transfer_opt_out: "the user says this is NOT a transfer". Set on unlink /
--   dismiss so the matcher never re-links a row the user pulled out. Blocks
--   auto-detection and suggestions only — manual linking stays possible and
--   clears it.
--
--   Shared source of truth so iOS can adopt later with no schema change.
-- ============================================================

alter table transactions
  add column if not exists transfer_kind text
    check (transfer_kind in ('auto', 'manual', 'one_sided')),
  add column if not exists transfer_opt_out boolean not null default false;

-- Legs linked before this migration were all manual (web TransferDialog).
update transactions set transfer_kind = 'manual'
  where transfer_group_id is not null and transfer_kind is null;

-- kind travels with the group id: both set or both null.
alter table transactions drop constraint if exists transfer_kind_matches_group;
alter table transactions add constraint transfer_kind_matches_group
  check ((transfer_kind is null) = (transfer_group_id is null));

-- Matcher lookup: a user's unlinked, not-opted-out rows by amount/date.
create index if not exists idx_transactions_transfer_match
  on transactions(user_id, amount, effective_date)
  where transfer_group_id is null and transfer_opt_out = false;
