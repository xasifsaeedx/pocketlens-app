-- ============================================================
-- CURRENT NET WORTH VIEW
--   Single source of truth for "live" net worth. Previously both clients
--   summed latest balances client-side (signed, no clamping) while the sync
--   service wrote net_worth_snapshots with different math (per-account
--   clamp-at-zero, inactive accounts excluded) — so the Accounts-page number
--   could disagree with the latest snapshot on the net-worth chart. Both
--   clients now read this view, which mirrors the snapshot writer.
--
--   Semantics (mirrors sync.py write_net_worth_snapshot, the reference):
--     * Plaid accounts: latest balance per account via latest_balances (not
--       just today's — an item that failed to sync today still counts),
--       active accounts only.
--     * Manual "separate accounts": balance = sum of signed ledger entries
--       in separate_account_values, active accounts only.
--     * Per-account balance clamped at zero (max(balance, 0)) before
--       summing, matching the snapshot writer.
--     * type in ('credit','loan') = liability (is_liability in sync.py);
--       everything else is an asset. net_worth = assets − liabilities.
--     * as_of = newest balance date among the user's active accounts'
--       latest_balances rows — the clients show it next to the number.
--
--   Also redefines latest_balances to skip null-balance rows (see below).
--
--   security_invoker: the view runs with the caller's RLS ("own" policies on
--   account_balance_history / accounts / separate_accounts /
--   separate_account_values), same pattern as latest_balances and
--   category_spend. latest_balances is itself security_invoker, so the
--   caller's RLS applies all the way down.
--
--   VERSION NOTE: minted by `supabase migration new` at the real UTC instant
--   2026-07-03 16:29:46, but legacy migrations are hand-dated into the future
--   (head 20260718140418) and this view depends on several of them, which
--   breaks CI's fresh-DB apply if the version sorts earlier. Date bumped to
--   20260719 (first free slot); the HHMMSS keeps the real mint time for
--   collision resistance. Moot once real time passes 2026-07-19.
-- ============================================================

-- latest_balances now skips null-balance rows, so an account whose newest
-- history row has current_balance = null falls back to its most recent
-- non-null balance (the pre-view client scans did this; without the filter,
-- distinct-on returns the null row and the account shows no balance at all).
-- Same effect in write_net_worth_snapshot: last-known real balance counts,
-- fitting its "an item that failed to sync today still counts" intent.
create or replace view latest_balances with (security_invoker = true) as
select distinct on (account_id)
  account_id, user_id, current_balance, available_balance, date
from account_balance_history
where current_balance is not null
order by account_id, date desc;

create or replace view current_net_worth with (security_invoker = true) as
select
  user_id,
  total_assets,
  total_liabilities,
  (total_assets - total_liabilities)::numeric(12,2) as net_worth,
  as_of
from (
  with contributions as (
    -- Plaid accounts: latest balance per account, active accounts only.
    select
      lb.user_id,
      greatest(coalesce(lb.current_balance, 0), 0) as balance,
      a.type in ('credit', 'loan') as is_liability,
      lb.date as as_of
    from latest_balances lb
    join accounts a on a.id = lb.account_id and a.is_active
    union all
    -- Separate accounts: balance = sum of signed ledger entries.
    select
      sa.user_id,
      greatest(coalesce(sum(v.amount), 0), 0) as balance,
      sa.type in ('credit', 'loan') as is_liability,
      null::date as as_of
    from separate_accounts sa
    left join separate_account_values v on v.separate_account_id = sa.id
    where sa.is_active
    group by sa.id
  )
  select
    user_id,
    coalesce(sum(balance) filter (where not is_liability), 0)::numeric(12,2) as total_assets,
    coalesce(sum(balance) filter (where is_liability), 0)::numeric(12,2)     as total_liabilities,
    max(as_of) as as_of
  from contributions
  group by user_id
) totals;

grant select on current_net_worth to authenticated;
grant select on current_net_worth to service_role;
