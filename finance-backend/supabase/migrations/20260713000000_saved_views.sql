-- ============================================================
-- SAVED VIEWS
--   A named, reusable filter set for the transactions list (category + tag filters).
--   The client captures its current filter state as a JSON blob and stores it here so
--   views persist across devices instead of living in localStorage. Shape of `params`
--   is owned by the client (web/src/data/savedViews.ts — SavedViewParams); the DB just
--   holds opaque jsonb, so the filter set can grow without a migration.
--
--   Flat RLS like every other table: user_id = auth.uid() (default auth.uid()).
-- ============================================================

create table saved_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null,
  params jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint saved_views_user_name unique (user_id, name)
);
create index idx_saved_views_user on saved_views(user_id);

alter table saved_views enable row level security;
create policy "own" on saved_views for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- API-role grants (mirror prior migrations; implicit defaults aren't present on a fresh stack).
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on saved_views to authenticated;
