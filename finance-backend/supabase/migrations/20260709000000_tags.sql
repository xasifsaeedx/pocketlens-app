-- ============================================================
-- TAGS
--   Free-form, user-defined labels on transactions (many-to-many), independent
--   of the single category_id. Source of truth lives here so iOS and web share
--   one schema; clients only add UI.
--
--   join table carries user_id (default auth.uid()) so RLS is a flat
--   `user_id = auth.uid()` like every other table — no subquery joins.
-- ============================================================

create table tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null,
  color text not null default '#8E8E93',   -- hex, rendered inline like category colors
  created_at timestamptz not null default now(),
  constraint tags_user_name unique (user_id, name)
);
create index idx_tags_user on tags(user_id);

create table transaction_tags (
  transaction_id uuid not null references transactions(id) on delete cascade,
  tag_id uuid not null references tags(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  primary key (transaction_id, tag_id)
);
create index idx_transaction_tags_tag on transaction_tags(tag_id);
create index idx_transaction_tags_user on transaction_tags(user_id);

alter table tags enable row level security;
create policy "own" on tags for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table transaction_tags enable row level security;
create policy "own" on transaction_tags for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- API-role grants (mirror 20260707; implicit defaults aren't present on a fresh stack).
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on tags to authenticated;
grant select, insert, update, delete on transaction_tags to authenticated;
