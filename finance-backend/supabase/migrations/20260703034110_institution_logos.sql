-- Institution branding from Plaid (institutions/get_by_id with
-- include_optional_metadata): base64 PNG logo, brand color, homepage URL.
-- Written at link time; the sync loop self-heals items that are missing it
-- (linked before this shipped, or the link-time fetch failed).
alter table plaid_items
  add column if not exists institution_logo text,
  add column if not exists institution_primary_color text,
  add column if not exists institution_url text;

-- Clients may read the new columns. This migration's real-UTC version sorts
-- BEFORE the fake-dated 20260704000000_multi_user.sql, whose revoke-and-
-- regrant of plaid_items would drop this grant on a fresh-DB apply — so that
-- file's grant list also names these columns (edited in the same PR). This
-- grant covers databases where multi_user already ran.
grant select (institution_logo, institution_primary_color, institution_url)
  on plaid_items to authenticated;
