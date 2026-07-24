-- Clean break on account deletion: fully sever a user's Plaid connections.
-- The app now calls Plaid item/remove for every active item in DELETE /account
-- (invalidating the access token on Plaid's side), and the plaid_items row must
-- then be deleted along with the user — no orphaned rows, no reconnect.
--
-- This supersedes 20260803000000_plaid_update_mode.sql, which changed this FK
-- to ON DELETE SET NULL (to keep the access_token alive for an orphaned-item
-- reconnect feature) but did NOT drop the user_id NOT NULL that
-- multi_user.sql (20260704000000) had set. That pair is impossible: deleting a
-- user with any linked bank makes Postgres try to NULL user_id, which the
-- NOT NULL check rejects, so the whole account deletion fails. We revert to the
-- original CASCADE end state and the reconnect feature/endpoints are removed in
-- the same PR. Idempotent and fresh-DB safe (runs after both prior migrations).

-- Defensive: orphaned rows (user_id NULL) left from the old SET NULL era would
-- block the NOT NULL re-assertion below. None exist today; drop any that do.
-- Their Plaid items were already abandoned under the old behavior, so this only
-- clears stale local rows.
delete from public.plaid_items where user_id is null;

alter table public.plaid_items alter column user_id set not null;

alter table public.plaid_items drop constraint if exists plaid_items_user_id_fkey;
alter table public.plaid_items
  add constraint plaid_items_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;
