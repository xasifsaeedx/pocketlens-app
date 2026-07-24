-- ============================================================
-- PROFILES
--   1:1 profile row per auth user, holding the user's first/last name.
--   `id` IS the auth user id (primary key + FK) — no separate user_id column,
--   so RLS is a flat `id = auth.uid()` like every other table's "own" policy.
--
--   A signup trigger auto-creates the row, pulling first_name/last_name from the
--   signup metadata (web `auth.signUp` writes them into raw_user_meta_data). Existing
--   users are backfilled with an empty row so they can UPDATE their name later.
--   Source of truth lives here so iOS and web share one schema; clients only add UI.
-- ============================================================

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text,
  last_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table profiles enable row level security;
create policy "own" on profiles for all to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- API-role grants (mirror the other tables; implicit defaults aren't present on a fresh stack).
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on profiles to authenticated;

-- ── Auto-create a profile on signup, seeded from the signup metadata ──────
-- security definer + empty search_path with fully-qualified names is the standard
-- Supabase pattern (satisfies the security advisor). nullif('') keeps a missing name
-- as NULL rather than an empty string.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, first_name, last_name)
  values (new.id,
          nullif(new.raw_user_meta_data->>'first_name', ''),
          nullif(new.raw_user_meta_data->>'last_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Backfill empty profile rows for existing users ────────────────────────
insert into public.profiles (id)
  select id from auth.users
  on conflict (id) do nothing;
