-- Pre-beta DB hardening. Addresses Supabase security + performance advisors before
-- opening the app to untrusted public users. No behavior change — RLS ownership rules
-- are identical, only their evaluation is optimized and defense-in-depth grants tightened.
--
-- 1. RLS initplan: wrap auth.uid() in a scalar subquery so Postgres evaluates it once
--    per statement instead of once per row (advisor 0003_auth_rls_initplan).
-- 2. Revoke anon EXECUTE on SECURITY DEFINER functions (advisors 0028/0029). Both are
--    already self-scoped to auth.uid(), so this is defense-in-depth, not a live hole.
-- 3. Pin search_path on the assert_split_sum trigger (advisor 0011).
-- 4. Add covering indexes for unindexed foreign keys (advisor 0001).

-- 1. RLS initplan optimization ------------------------------------------------
-- ALTER POLICY preserves cmd + roles; only the ownership expression is rewritten.
alter policy "own" on public.account_balance_history using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.accounts                using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.activity_log            using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.budget_limits           using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.budgets                 using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.categories              using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.category_groups         using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.category_rules          using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.device_tokens           using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.group_budget_limits     using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.merchant_categories     using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.net_worth_snapshots     using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.notification_prefs      using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.notifications           using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.recurring_contributions using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.recurring_overrides     using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.saved_views             using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.separate_account_values using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.separate_accounts       using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.tag_budget_limits       using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.tag_category_rules      using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.tags                    using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.transaction_splits      using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.transaction_tags        using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.transactions            using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.zbb_assignments         using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.zbb_months              using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
alter policy "own" on public.zbb_settings            using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- profiles keys on id (id IS the auth user id), not user_id.
alter policy "own" on public.profiles                using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- Read-only-to-client tables: SELECT policy only, no WITH CHECK.
alter policy "own_read" on public.plaid_items        using ((select auth.uid()) = user_id);
alter policy "own_read" on public.plaid_credentials  using ((select auth.uid()) = user_id);
alter policy "own_read" on public.sync_log           using ((select auth.uid()) = user_id);

-- 2. Tighten SECURITY DEFINER execute grants ---------------------------------
-- handle_new_user runs only as an auth.users trigger; no role needs a direct grant.
revoke execute on function public.handle_new_user() from anon, authenticated, public;
-- zbb_move_money is called by signed-in users; drop only the anon/public grant.
revoke execute on function public.zbb_move_money(integer, integer, uuid, uuid, numeric) from anon, public;

-- 3. Pin trigger search_path -------------------------------------------------
alter function public.assert_split_sum() set search_path = public;

-- 4. Covering indexes for foreign keys ---------------------------------------
create index if not exists idx_accounts_plaid_item_id      on public.accounts(plaid_item_id);
create index if not exists idx_budget_limits_category_id   on public.budget_limits(category_id);
create index if not exists idx_budgets_category_id         on public.budgets(category_id);
create index if not exists idx_categories_parent_id        on public.categories(parent_id);
create index if not exists idx_category_rules_category_id  on public.category_rules(category_id);
create index if not exists idx_group_budget_limits_group_id on public.group_budget_limits(group_id);
create index if not exists idx_merchant_categories_category_id on public.merchant_categories(category_id);
create index if not exists idx_sync_log_user_id            on public.sync_log(user_id);
create index if not exists idx_tag_budget_limits_tag_id    on public.tag_budget_limits(tag_id);
create index if not exists idx_tag_category_rules_category_id on public.tag_category_rules(category_id);
create index if not exists idx_transaction_splits_category_id on public.transaction_splits(category_id);
create index if not exists idx_zbb_assignments_category_id on public.zbb_assignments(category_id);
