-- ============================================================
-- SYNC PERF + CORRECTNESS
--   F8  latest-balance lookups (net worth used only "today" before)
--   F7  per-item sync lock (stop concurrent webhook/cron races)
-- ============================================================

-- F8: net worth now reads the latest balance PER account (not a hardcoded
-- date), so this index makes distinct-on(account_id) cheap.
create index if not exists idx_balance_history_account_date
  on account_balance_history(account_id, date desc);

-- F8: one row per account = its most recent balance snapshot.
create or replace view latest_balances as
select distinct on (account_id)
  account_id, current_balance, available_balance, date
from account_balance_history
order by account_id, date desc;

-- F7: sync lock. A pg_advisory_lock RPC is unreliable through PostgREST's
-- pooled connections (acquire and release land on different backends), so use
-- a plain flag row with a stale timeout instead.
-- ponytail: 15-min stale timeout is the ceiling; a crashed sync frees the lock
-- on the next attempt after 15 min. Shorten if syncs are always fast.
alter table plaid_items add column if not exists is_syncing bool not null default false;
alter table plaid_items add column if not exists sync_started_at timestamptz;
