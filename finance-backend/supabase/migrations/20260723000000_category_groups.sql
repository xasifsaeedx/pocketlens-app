-- ============================================================
-- CATEGORY GROUPS
--   Named containers that each category can optionally belong to
--   (0 or 1 group per category). Groups are purely organisational —
--   no color or icon — and will later power "view all transactions
--   in this group" across clients.
--
--   Schema decisions:
--     • category_groups owns user_id + sort_order (drag-to-reorder).
--     • categories.group_id is a nullable FK; SET NULL on group delete
--       so removing a group gracefully ungroupes its categories.
--     • RLS mirrors every other user-owned table: own-row via user_id.
-- ============================================================

-- ── 1. category_groups table ────────────────────────────────────────
create table if not exists category_groups (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users(id) on delete cascade default auth.uid(),
  name       text        not null,
  sort_order int         not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_category_groups_user on category_groups(user_id);

-- ── 2. group_id FK on categories ────────────────────────────────────
alter table categories
  add column if not exists group_id uuid references category_groups(id) on delete set null;

create index if not exists idx_categories_group on categories(group_id);

-- ── 3. RLS ──────────────────────────────────────────────────────────
alter table category_groups enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'category_groups' and policyname = 'own'
  ) then
    create policy "own" on category_groups
      for all to authenticated
      using  (user_id = auth.uid())
      with check (user_id = auth.uid());
  end if;
end $$;
