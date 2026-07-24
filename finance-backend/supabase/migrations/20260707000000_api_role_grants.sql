-- ============================================================
-- EXPLICIT API-ROLE GRANTS
--   Make the schema self-contained instead of relying on Supabase's implicit
--   default privileges. Those defaults exist on the hosted project (so the app
--   works), but are NOT applied on a fresh/local stack — there the authenticated
--   role has no table privileges and every query fails with "permission denied
--   for table ..." (42501). RLS still gates every row; these grants only open the
--   tables to the API roles.
-- ============================================================

grant usage on schema public to anon, authenticated, service_role;

-- Service role bypasses RLS and owns all server-side writes (incl. access tokens).
grant all on all tables in schema public to service_role;

-- authenticated: full DML, scoped to its own rows by the "own" RLS policies.
do $$
declare t text;
begin
  foreach t in array array[
    'categories','accounts','transactions','category_rules',
    'account_balance_history','net_worth_snapshots','budgets',
    'separate_accounts','separate_account_values','recurring_contributions',
    'merchant_categories'
  ] loop
    execute format('grant select, insert, update, delete on %I to authenticated', t);
  end loop;
end $$;

-- Read-only surfaces for the client.
grant select on sync_log to authenticated;         -- "own_read" policy
grant select on latest_balances to authenticated;  -- user-scoped view (security_invoker)

-- NOTE: plaid_items intentionally keeps only the column-level SELECT grant from
-- 20260704 (access_token withheld); it is deliberately not re-granted here.
