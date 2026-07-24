-- Activity log — one row per notable user mutation, powering the in-app Activity
-- screen and one-tap Undo. Written by both clients (iOS + web) right after a
-- successful mutation. `before`/`after` carry the minimal JSON needed to display
-- the entry and to reverse it; `reversible` gates whether an Undo button shows;
-- `undone` marks entries already reverted (so they can't be undone twice).
--
-- Owner-scoped like every other user table: user_id defaults to auth.uid() so
-- client inserts auto-stamp the owner, and RLS is a simple indexed
-- user_id = auth.uid() check.

create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  created_at timestamptz not null default now(),
  -- categorize | hide | unhide | set_budget | delete_budget | add_rule | delete_rule
  action_type text not null,
  -- transaction | budget | category_rule
  entity_type text not null,
  -- affected row; nullable for deletes where the row no longer exists
  entity_id uuid,
  -- human-readable, e.g. "Categorized Chipotle as Dining"
  summary text not null,
  -- minimal state to restore on undo (null when not reversible)
  before jsonb,
  -- resulting state, for display
  after jsonb,
  reversible boolean not null default true,
  undone boolean not null default false,
  undone_at timestamptz
);

-- Activity screen reads newest-first for the current user.
create index if not exists idx_activity_log_user_created
  on activity_log(user_id, created_at desc);

alter table activity_log enable row level security;

create policy "own" on activity_log for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
