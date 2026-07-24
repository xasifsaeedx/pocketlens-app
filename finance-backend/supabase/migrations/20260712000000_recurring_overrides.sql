-- ============================================================
-- RECURRING OVERRIDES
--   Recurring charges (subscriptions, memberships, bills) are *detected* live on
--   the client by grouping transactions by merchant + cadence — no stored series,
--   no backend job (the analysis re-runs from live transaction data each load, so
--   it can never go stale). See web/src/lib/recurring.ts.
--
--   The only thing that needs to persist is the USER's decision about a detected
--   series: confirm it, ignore it (hide the suggestion), or remove it. A series is
--   identified by its normalized merchant key (transactions.merchant_name/description
--   lowercased — the same merchant_key the categorizer already uses), so an override
--   is keyed by (user_id, merchant_key). Default (no row) = "suggested".
--
--   ponytail: detection is a client-side O(n) scan of the recent-transaction window,
--   not a precomputed recurring_series table + cron. Upgrade path if the window grows
--   too large to scan client-side: materialize series in a table written by a backend
--   job and read them here instead — this overrides table stays valid either way.
-- ============================================================

create table recurring_overrides (
  id uuid primary key default gen_random_uuid(),
  merchant_key text not null,
  status text not null check (status in ('confirmed', 'ignored', 'removed')),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  unique (user_id, merchant_key)
);
create index idx_recurring_overrides_user on recurring_overrides(user_id);

alter table recurring_overrides enable row level security;
create policy "own" on recurring_overrides for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- API-role grants (mirror prior migrations; implicit defaults aren't present on a fresh stack).
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on recurring_overrides to authenticated;
