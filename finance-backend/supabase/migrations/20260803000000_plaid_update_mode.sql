-- ============================================================
-- PLAID UPDATE MODE: preserve access_tokens on account deletion
--
-- When a user deletes their account, plaid_items rows previously cascaded
-- away, losing the encrypted access_token forever. This burned a Plaid slot
-- because re-linking the same bank created a new Item on Plaid's side.
--
-- Fix: change plaid_items.user_id from ON DELETE CASCADE to ON DELETE SET NULL.
-- Orphaned rows (user_id IS NULL) retain the access_token so a re-created
-- user with the same plaid_client_id can reconnect via Link Update Mode
-- without burning a new slot.
-- ============================================================

-- Drop the existing FK constraint and re-add with SET NULL.
-- The constraint name follows Supabase's default naming: plaid_items_user_id_fkey.
alter table plaid_items drop constraint plaid_items_user_id_fkey;
alter table plaid_items
  add constraint plaid_items_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

-- Allow the service role to query orphaned items (user_id IS NULL) by client_id.
-- The existing RLS policy "own_read" already filters on user_id = auth.uid(),
-- so orphaned rows are invisible to regular users — only the backend
-- (service_role) can see and claim them.
